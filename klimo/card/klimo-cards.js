/**
 * Klimo Lovelace cards.
 *
 * Room-by-room climate on the Home Assistant dashboard. The add-on publishes everything the
 * cards show as MQTT entities: the hub sensor (`sensor.klimo_hub`: house, season, sources,
 * rooms), one card sensor per room (`sensor.klimo_<slug>_card`: card texts, sparkline,
 * thermostat model, device sync) and a reply sensor (`sensor.klimo_reply`: the answers to
 * card commands). Entities are also found by the shape of their attributes, so renamed ids
 * keep working. Commands go back through `mqtt.publish` on `klimo/command`; every command
 * carries a `reqId` and the card waits for the matching reply.
 *
 * Texts arrive rendered by the add-on in its notification language; only the chrome of the
 * cards (buttons, countdowns, hints) lives in the dictionary below. Durations and clock
 * times inside texts are `{d}` / `{t}` placeholders resolved here against the `at` next to
 * the text, so the attributes do not change every minute.
 *
 * No build step, no dependencies: plain custom elements.
 *
 * Usage:
 *
 *   type: custom:klimo-room-card          # one room at a glance; tap opens the room sheet
 *   room: vitalnia                        # slug, room id or climate.klimo_<slug>
 *   variant: card                         # card | compact
 *   show_sparkline: true
 *   show_meta: [humidity, window, device]
 *   show_issue: true
 *   tap_action: { action: klimo-room-sheet }
 *   hold_action: { action: klimo-open }   # the room page in the Klimo panel
 *
 *   type: custom:klimo-rooms-card         # all rooms as compact rows
 *   rooms: all                            # all | [slugs or ids]
 *   exclude: []
 *   variant: compact                      # compact | card
 *   sort: attention_first                 # attention_first | config | name | temperature
 *   title: Кімнати
 *
 *   type: custom:klimo-thermostat-card    # −/+ or the knob; 3 s to cancel, 8 s to undo
 *   room: vitalnia                        # or rooms: all | [slugs] — swipe between rooms
 *   controls: direct                      # direct | locked | admin_only
 *   step: 0.5                             # 0.1 | 0.5 | 1 (default: the room's step)
 *   drag: knob_only                       # knob_only | off
 *   send_delay: 3                         # 0–10 s
 *   undo_seconds: 8                       # 0–30 s
 *   default_duration: slot                # slot | 1h | 3h | manual | forever
 *   durations: [slot, 1h, 3h, manual, forever]   # manual: until the schedule is resumed
 *   quick_actions: [boost, airing]
 *   show_schedule: true
 *   show_meta: true
 *
 *   type: custom:klimo-house-card         # season, headline, system tiles, profile, attention
 *   show_profile: true
 *   profile_change: confirm               # confirm | navigate | none
 *   profile_durations: [slot, 2h, morning, none]
 *   show_attention: true
 *   show_system: [source, pumps, outdoor] # cooling swaps pumps for humidity unless set
 *
 *   type: custom:klimo-system-card        # sources, circuits, energy and triggers
 *   show: [sources, circuits, energy, triggers]
 *   sources: all                          # all | active | [source ids]
 *
 * Common options: theme (auto | dark | light), language (auto | uk | en), title,
 * hub_entity, tap_action / hold_action / double_tap_action (Home Assistant actions plus
 * `klimo-room-sheet` and `klimo-open`).
 */

const VERSION = '0.2.6';

/* ─────────────────────────────── 1 Tokens ──────────────────────────────────────────────────────
 * The same values as the panel's design tokens. `npm run tokens:card` in klimo/frontend copies
 * them in; edit the panel's tokens, not this block. */

/* @tokens:begin */
const TOKENS = {
  dark: {
    bgPage: '#0E1013',
    bgChrome: '#121417',
    surface1: '#171A1E',
    surface2: '#1F2328',
    surface3: '#272C32',
    surface4: '#2E333A',
    surfaceElevated: '#2A2E34',
    shadowElevated: '0 8px 24px rgba(0,0,0,.35)',
    border: '#2A2F36',
    borderStrong: '#343A42',
    divider: '#23272D',
    ring: '#4A515A',
    track: '#262A30',
    dot: '#3A4048',
    controlOff: '#5A616B',
    text1: '#ECEEF1',
    text2: '#B3BAC3',
    text3: '#8C949E',
    textNeutralStrong: '#D5D9DE',
    textDisabled: '#6B737D',
    band: 'rgba(236,238,241,.09)',
    scrim: 'rgba(5,6,8,.62)',
    actionBg: '#ECEEF1',
    actionFg: '#0E1013',
    tones: {
      heat: { bg: 'rgba(255,138,61,.15)', fg: '#FFB27A', line: '#FF8A3D', solid: '#FF8A3D', ink: '#2A1204' },
      cool: { bg: 'rgba(77,166,255,.15)', fg: '#9CCBFF', line: '#4DA6FF', solid: '#4DA6FF', ink: '#04172A' },
      hold: { bg: '#23272D', fg: '#D5D9DE', line: '#D5D9DE', solid: '#D5D9DE', ink: '#0E1013' },
      warn: { bg: 'rgba(242,193,78,.15)', fg: '#F5D57E', line: '#F2C14E', solid: '#F2C14E', ink: '#1E1603' },
      err: { bg: 'rgba(240,113,107,.15)', fg: '#FF9F9A', line: '#F0716B', solid: '#F0716B', ink: '#2B0A08' },
      off: { bg: '#1F2328', fg: '#9AA2AC', line: '#8C949E', solid: '#5A616B', ink: '#ECEEF1' },
      ok: { bg: 'rgba(76,195,138,.13)', fg: '#8FE0B5', line: '#4CC38A', solid: '#4CC38A', ink: '#04201A' },
      event: { bg: 'rgba(155,135,245,.12)', fg: '#CFC5FF', line: '#9B87F5', solid: '#9B87F5', ink: '#140F2E' },
    },
  },
  light: {
    bgPage: '#F2F3F5',
    bgChrome: '#FFFFFF',
    surface1: '#FFFFFF',
    surface2: '#F4F5F7',
    surface3: '#E9EBEF',
    surface4: '#E3E6EA',
    surfaceElevated: '#FFFFFF',
    shadowElevated: '0 8px 24px rgba(20,23,26,.12)',
    border: '#E1E4E9',
    borderStrong: '#D3D7DD',
    divider: '#E9EBEF',
    ring: '#B9BFC8',
    track: '#E6E8EC',
    dot: '#C9CED6',
    controlOff: '#9AA1AA',
    text1: '#14171A',
    text2: '#454D57',
    text3: '#646C76',
    textNeutralStrong: '#343B44',
    textDisabled: '#9AA1AA',
    band: 'rgba(20,23,26,.07)',
    scrim: 'rgba(5,6,8,.62)',
    actionBg: '#14171A',
    actionFg: '#FFFFFF',
    tones: {
      heat: { bg: '#FFEADB', fg: '#A84A0C', line: '#E8701F', solid: '#C75A12', ink: '#FFFFFF' },
      cool: { bg: '#E2EEFC', fg: '#1D64B3', line: '#2F86E0', solid: '#1D6FC4', ink: '#FFFFFF' },
      hold: { bg: '#EEF0F3', fg: '#343B44', line: '#343B44', solid: '#343B44', ink: '#FFFFFF' },
      warn: { bg: '#FFF1CC', fg: '#7D5700', line: '#C48F00', solid: '#F2C14E', ink: '#1E1603' },
      err: { bg: '#FCE6E4', fg: '#A8261C', line: '#D9483D', solid: '#C23A2F', ink: '#FFFFFF' },
      off: { bg: '#F1F2F4', fg: '#5A626C', line: '#646C76', solid: '#646C76', ink: '#FFFFFF' },
      ok: { bg: '#DDF3E7', fg: '#1A7149', line: '#1E8A57', solid: '#1A7149', ink: '#FFFFFF' },
      event: { bg: '#EEEAFE', fg: '#5B47C9', line: '#7C68E6', solid: '#5B47C9', ink: '#FFFFFF' },
    },
  },
  profiles: [
    { color: '#9B87F5', ink: '#140F2E' },
    { color: '#7D8896', ink: '#0E1013' },
    { color: '#57C48B', ink: '#062012' },
    { color: '#4F5FD6', ink: '#FFFFFF' },
    { color: '#E87AB4', ink: '#2A0718' },
    { color: '#C9B56E', ink: '#231D05' },
    { color: '#3BB6B0', ink: '#04201F' },
    { color: '#F07C5A', ink: '#2A0B04' },
    { color: '#A6C94A', ink: '#172003' },
    { color: '#5AA9E6', ink: '#04172A' },
    { color: '#B57EDC', ink: '#1E0B2A' },
    { color: '#A39E93', ink: '#16140F' },
  ],
};
/* @tokens:end */

/* ─────────────────────────────── 2 Icons ───────────────────────────────────────────────────────
 * 24×24, stroke 2, round caps and joins, no fill; the same names and paths as the panel, so a
 * glyph means the same thing on the dashboard and in Klimo. */

const ICONS = {
  flame: 'M12 3c.9 3.2 4.8 5.1 4.8 9.6a4.8 4.8 0 0 1-9.6 0c0-2.3 1.3-3.8 2.3-4.7.4 1.8 1.4 2.8 2.4 2.8 0-2.9-.9-5.2.1-7.7z',
  snow: 'M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.2l2.4 2.4 4.6-4.8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  windowOpen: 'M3 4h9v16H3zM12 4l8 3v10l-8 3',
  windowClosed: 'M5 3h14v18H5zM12 3v18M5 12h14',
  alert: 'M12 4 21 20H3zM12 10v4.5M12 17.5v.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.01',
  power: 'M12 3v8M7 6.3a8 8 0 1 0 10 0',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.9-2.6L3.2 14.9a1.6 1.6 0 0 1 2.6-1.8L8 15.6',
  bolt: 'M13 2 4.5 13H11l-1 9 9.5-11H13z',
  pause: 'M9 5v14M15 5v14',
  airing: 'M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z',
  sync: 'M20 12a8 8 0 0 0-14-5.3L4 9M4 4v5h5M4 12a8 8 0 0 0 14 5.3l2-2.3M20 20v-5h-5',
  offline: 'M5 12.6a10 10 0 0 1 3.6-2.3M2 9a15 15 0 0 1 4.5-2.8M19 12.6a10 10 0 0 0-5.6-2.5M22 9a15 15 0 0 0-11-3.9M8.5 16a5 5 0 0 1 7 0M12 20v.01M3 3l18 18',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2',
  droplet: 'M12 3s6.5 6.6 6.5 11.2a6.5 6.5 0 0 1-13 0C5.5 9.6 12 3 12 3z',
  thermometer: 'M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z',
  radiator: 'M6 5v14M10 5v14M14 5v14M18 5v14M4 7h16M4 17h16',
  floor: 'M3 20h18M6 16c0-1.6 1.6-1.9 1.6-3.5S6 10.6 6 9M11.2 16c0-1.6 1.6-1.9 1.6-3.5s-1.6-1.9-1.6-3.5M16.4 16c0-1.6 1.6-1.9 1.6-3.5s-1.6-1.9-1.6-3.5',
  ac: 'M3 6h18v7H3zM6 10h12M8 16.5c0 1.5-1 2.5-1 2.5M12 16.5V19M16 16.5c0 1.5 1 2.5 1 2.5',
  heatPump: 'M3 5h18v14H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 9V6.5M12 17.5V15M9 12H6.5M17.5 12H15',
  boiler: 'M6 3h12v18H6zM9 7h6M12 17.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  electricBoiler: 'M6 3h12v18H6zM13 7l-3 5h4l-3 5',
  convector: 'M4 6h16v11H4zM7 20v-3M17 20v-3M8 10h8M8 13h8',
  irBlaster: 'M4 4h16v6H4zM7 14l-1 3M12 14v4M17 14l1 3',
  anyEntity: 'M8 8h8v8H8zM3 10h5M3 14h5M16 10h5M16 14h5M10 3v5M14 3v5M10 16v5M14 16v5',
  fan: 'M12 12c0-4 1-8 4-8s3 4 0 6M12 12c4 0 8 1 8 4s-4 3-6 0M12 12c0 4-1 8-4 8s-3-4 0-6M12 12c-4 0-8-1-8-4s4-3 6 0',
  pumps: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12l5-5M12 12l-5 5M12 12l5 5M12 12 7 7',
  manifold: 'M4 7h16M4 12h16M4 17h16M8 7v10M16 7v10',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5',
  swap: 'M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4',
  home: 'M3 11 12 4l9 7M5.5 9.5V20h13V9.5M10 20v-5h4v5',
  away: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  leaf: 'M5 19c0-8.5 5.5-14 15-14 0 9.5-5.5 15-14 15M5 19c3-4 6-6.5 9.5-8',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  suitcase: 'M4 8h16v12H4zM9 8V5h6v3M4 13h16',
  trendUp: 'M4 16l5-5 4 4 7-7M15 8h5v5',
  trendDown: 'M4 8l5 5 4-4 7 7M15 16h5v-5',
  trendFlat: 'M4 12h15M15 8l4 4-4 4',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  gap: 'M8 7l-4 5 4 5M16 7l4 5-4 5',
  range: 'M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8zM10 20a2 2 0 0 0 4 0',
  send: 'M22 3 2 10.5l7 2.5 2.5 7.5 3.5-5 5.5 4z',
  sendTest: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  phone: 'M7 2h10v20H7zM11 18h2',
  tablet: 'M4 4h16v16H4zM11 17h2',
  dot: 'M12 12h.01',
  play: 'M6 4l14 8-14 8z',
  settings: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  list: 'M4 6h16M4 12h16M4 18h10',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  sofa: 'M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4H3zM6 17v2M18 17v2',
  bed: 'M3 5v14M3 15h18M21 19v-6a3 3 0 0 0-3-3h-8v5M6.5 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  kids: 'M4 14h7v7H4zM13 14h7v7h-7zM8.5 4h7v7h-7z',
  desk: 'M3 8h18M5 8v12M19 8v12M13 8v6h6M13 11h6',
  kitchen: 'M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM2 10h2M20 10h2M9.5 6.5c0-1 1-1.5 1-2.5M13.5 6.5c0-1 1-1.5 1-2.5',
  bath: 'M3 12h18v2a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zM6 12V6a2 2 0 0 1 3.5-1.3M7 19l-1 2M17 19l1 2',
  hall: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14.5 12v.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  signal: 'M4 20v-3M9 20v-7M14 20V9M19 20V4',
  zigbee: 'M6 6h12L6 18h12',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5M12 16v.01',
  grid_power: 'M12 3 8 21M12 3l4 18M6 8h12M7 13h10M8 21h8',
  battery_storage: 'M8 5h8v16H8zM10 3h4v2M12.5 9l-2 4h3l-2 4',
  solar: 'M4 15h16l-2-9H6zM10 6l-1 9M14 6l1 9M5 10.5h14M12 15v4M8 19h8',
};

/** An inline icon; unknown names fall back to a neutral glyph instead of breaking the card. */
function ic(name, size = 14, cls = '') {
  const d = ICONS[name] || ICONS.anyEntity;
  return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

/* ─────────────────────────────── 3 Dictionary ──────────────────────────────────────────────────
 * Chrome of the cards only; everything about the house arrives rendered by the add-on. */

const STRINGS = {
  uk: {
    waiting: 'Чекаю на дані Klimo',
    waitingFound: 'Знайдено {ids}, але даних ще немає.',
    waitingHint: 'Чи працює доповнення Klimo і чи підключено MQTT? Стан MQTT видно в налаштуваннях Klimo.',
    offline: 'Klimo не на зв’язку',
    offlineSince: 'Klimo не на зв’язку · дані від {t}',
    roomNotFound: 'Кімнату «{room}» не знайдено',
    pickRoom: 'Оберіть кімнату в налаштуваннях картки',
    rooms: 'Кімнати',
    house: 'Будинок',
    system: 'Система',
    noRooms: 'Немає кімнат',

    st_heat: 'Гріє', st_cool: 'Охолоджує', st_hold: 'Тримає', st_wait: 'Чекає', st_window: 'Вікно',
    st_off: 'Вимкнено', st_frost: 'Захист', st_error: 'Немає даних', st_monitor: 'Моніторинг',

    openRoom: 'Відкрити кімнату в Klimo',
    newTarget: 'Нова ціль',
    notSent: 'Нова ціль · ще не надіслано',
    notColder: 'Не холодніше, ніж',
    notWarmer: 'Не тепліше, ніж',
    inRange: 'У межах',
    windowPause: 'Пауза · вікно',
    now: 'зараз {v}',
    sendIn: 'Надішлю за {n} с',
    closeIn: 'Закрию за {n} с',
    release: 'Відпустіть, щоб обрати',
    dragHint: 'Тягніть по дузі — значення під пальцем',
    cancel: 'Скасувати',
    undo: 'Повернути · {n}',
    howLong: 'Як довго діє нова ціль',
    until: 'до {t}',
    untilSlotEnd: 'до кінця слоту',
    inProfile: 'у профілі «{p}»',
    appliedTarget: 'Ціль {v} {u}',
    appliedRange: 'Межі {v} {u}',
    manualLine: 'Вручну {v} · {u}',
    updatedLine: '{p} (оновлено) · {u}',
    same: 'Ціль та сама — нічого не надішлю',
    gapWarn: 'Межі не ближче {n}° одна до одної',
    keepHeat: 'Продовжить гріти · {eta}, до {t}',
    startHeat: 'Почне гріти · {eta}, до {t}',
    stopHeat: 'Опалення зупиниться · вже {v}',
    noHeat: 'Гріти не потрібно · вже {v}',
    heatTo: 'Грітиме до {v}, далі тримає',
    keepCool: 'Продовжить охолоджувати · {eta}, до {t}',
    startCool: 'Почне охолоджувати · {eta}, до {t}',
    stopCool: 'Охолодження зупиниться · вже {v}',
    noCool: 'Охолоджувати не потрібно · вже {v}',
    coolTo: 'Охолоджуватиме до {v}, далі тримає',
    noChange: 'Без змін · у межах {lo}–{hi}',
    windowLater: 'Ціль діятиме після закриття вікна',
    windowResume: 'Відновлю через 2 хв після закриття',
    roomOn: 'Кімната ввімкнеться з ціллю {v}',
    boost: '{s}{n}° на {m} хв',
    airing: 'Провітрити {m} хв',
    airingStop: 'Зупинити провітрювання',
    resume: 'Повернути розклад',
    resumeHouse: 'Повернути розклад для всього дому',
    houseResumed: 'Увесь дім знову за розкладом',
    turnOn: 'Увімкнути кімнату',
    ctl: 'Керування кімнатою',
    ctl_schedule: 'За розкладом',
    ctl_manual: 'Вручну',
    ctl_off: 'Вимкнено',
    manualHold: 'Вручну · розклад не змінює ціль',
    manualNote: 'Вручну, поки не повернете розклад',
    manualHeld: 'Вручну {v}',
    appliedManual: 'Ціль {v} · вручну',
    offHold: 'Вимкнено · захист від морозу лишається',
    locked: 'Лише перегляд',
    minus: 'Зменшити ціль на {n}°',
    plus: 'Збільшити ціль на {n}°',
    minusBound: 'Зменшити {b} на {n}°',
    plusBound: 'Збільшити {b} на {n}°',
    boundLo: '«не холодніше»',
    boundHi: '«не тепліше»',
    pickLo: 'Не холодніше, ніж {v}. Обрати для −/+',
    pickHi: 'Не тепліше, ніж {v}. Обрати для −/+',
    slider: 'Ціль кімнати',
    sliderLo: 'Нижня межа',
    sliderHi: 'Верхня межа',
    pager: 'Кімната {i} з {n}, гортайте вбік',
    syncSending: 'Надсилаю на {dev}…',
    syncSendingAny: 'Надсилаю…',
    syncPartialTrv: 'Підтвердила {a} з {n} головок…',
    syncPartialAc: 'Чекаю підтвердження кондиціонера…',
    syncPartialMixed: 'Підтверджено {a} з {n}…',
    syncDoneTrv1: 'Головка підтвердила {v}',
    syncDoneTrv2: 'Обидві головки підтвердили {v}',
    syncDoneTrvN: 'Усі {n} {heads} підтвердили {v}',
    syncDoneAc: 'Кондиціонер підтвердив {v}',
    syncDoneMixed: 'Пристрої підтвердили {v}',
    syncSaved: 'Збережено: {v}',
    syncRetry: 'Повтор {a}/{m}…',
    syncFailed: 'Не підтвердили {n} з {t} · перевірте пристрої',
    devTrv: 'головки {a}/{n}',
    devAc: 'кондиціонер',
    devMixed: 'кондиціонер + {n} {heads}',
    devHeater: 'обігрівач',
    devZone: 'клапан підлоги',
    acc_heads: ['головку', 'головки', 'головок'],
    nom_heads: ['головка', 'головки', 'головок'],
    theAc: 'кондиціонер',
    acAndHeads: 'кондиціонер і {n} {heads}',
    degraded: 'Спрощений режим: зміна діє до кінця слоту, без скасування',
    failed: 'Не вдалося: {e}',
    noReply: 'Klimo не відповів',
    undone: 'Повертаю попередню ціль…',
    dur_slot: 'До {t}',
    dur_slotOpen: 'До кінця слоту',
    dur_1h: '1 год',
    dur_2h: '2 год',
    dur_3h: '3 год',
    dur_morning: 'До ранку',
    dur_forever: 'Постійно',
    dur_manual: 'Поки не поверну розклад',
    dur_none: 'Без обмеження',

    seasonAuto: 'Авто · {s}',
    season_heating: 'опалення',
    season_cooling: 'охолодження',
    season_neutral: 'міжсезоння',
    modeHeat: 'Опалення',
    modeCool: 'Охолодження',
    modeOff: 'Вимкнено',
    seasonOf: 'сезон {s}',
    seasonBetween: 'міжсезоння',
    change: 'Змінити',

    profileSheet: 'Профіль будинку',
    profileNow: 'зараз',
    duration: 'Скільки діє',
    consequences: 'Що зміниться',
    pickProfile: 'Оберіть профіль або тривалість',
    counting: 'Рахую наслідки…',
    noPreview: 'Klimo не відповів — наслідки невідомі, застосувати все одно можна',
    apply: 'Застосувати',
    profileApplied: 'Профіль «{p}» {u}',
    profileCleared: 'Розклад повернуто',
    frostOnly: 'лише захист',

    triggers: 'Тригери:',
    schema: 'Схема й журнал рішень',
    role_lead: 'основне',
    role_together: 'разом з основним',
    role_reserve: 'резерв',
    role_assist: 'догрів',
    role_trigger_only: 'лише за тригером',
    role_room_primary: 'у кімнаті',
    role_unused: 'не задіяне',
    since: 'з {t}',
    sun: 'сонце {v}',
    battery: 'батарея {v}%',
    load: 'будинок {v}',
    kw: '{v} кВт',
    w: '{v} Вт',

    close: 'Закрити',
    openKlimo: 'Відкрити в Klimo',
    sensors: 'Датчики',
    why: 'Чому так',
    ignore30: 'Ігнорувати 30 хв',
    hide: 'Сховати',
    moreIssues: 'і ще {n}',
    e_temperature: 'Температура',
    e_humidity: 'Вологість',
    e_dew_point: 'Точка роси',
    e_target: 'Ціль',
    e_window: 'Вікно',
    e_heat_demand: 'Запит тепла',
    e_cool_demand: 'Запит холоду',
    on_window: 'відкрите',
    off_window: 'закрите',
    on_demand: 'так',
    off_demand: 'ні',
    unavailable: 'недоступно',

    min: '{n} хв',
    hm: '{h} год {m} хв',
    h: '{h} год',
    dh: '{d} дн {h} год',
    lessMin: '<1 хв',
    approx: '≈ {v}',

    ed_room: 'Кімната',
    ed_rooms: 'Кімнати',
    ed_all: 'усі',
    ed_variant: 'Вигляд',
    ed_card: 'картка',
    ed_compact: 'рядок',
    ed_theme: 'Тема',
    ed_auto: 'як у Home Assistant',
    ed_dark: 'темна',
    ed_light: 'світла',
    ed_language: 'Мова',
    ed_title: 'Заголовок',
    ed_sort: 'Порядок',
    ed_controls: 'Керування',
    ed_direct: 'дозволене',
    ed_lockedOpt: 'лише перегляд',
    ed_adminOnly: 'лише адміністраторам',
    ed_sparkline: 'графік за 6 год',
    ed_issue: 'проблему замість деталей',
    ed_meta: 'Деталі',
    ed_schedule: 'смугу розкладу',
    ed_metaRow: 'вологість, вікна, пристрої',
    ed_profile: 'профіль будинку',
    ed_attention: 'що потребує уваги',
    ed_profileChange: 'Зміна профілю',
    ed_confirm: 'з підтвердженням',
    ed_navigate: 'відкрити Klimo',
    ed_none: 'вимкнено',
    ed_tiles: 'Плитки',
    ed_sections: 'Розділи',
    ed_sources: 'Джерела',
    ed_step: 'Крок',
    ed_roomStep: 'як у кімнаті',
    ed_quick: 'Швидкі дії',
    ed_durations: 'Тривалості',
    ed_defaultDuration: 'Тривалість за замовчуванням',
    ed_attentionFirst: 'спершу ті, що потребують уваги',
    ed_config: 'як у Klimo',
    ed_name: 'за назвою',
    ed_temperature: 'за температурою',
    ed_active: 'лише ті, що працюють',
    k_humidity: 'вологість', k_window: 'вікно', k_device: 'пристрій', k_source: 'джерело', k_pumps: 'насоси',
    k_outdoor: 'надворі', k_sources: 'джерела', k_circuits: 'контури', k_energy: 'енергія', k_triggers: 'тригери',
    k_boost: 'підсилення', k_airing: 'провітрювання',
  },
  en: {
    waiting: 'Waiting for Klimo data',
    waitingFound: 'Found {ids}, but no data yet.',
    waitingHint: 'Is the Klimo add-on running with MQTT connected? The MQTT status is shown in Klimo’s settings.',
    offline: 'Klimo is offline',
    offlineSince: 'Klimo is offline · data from {t}',
    roomNotFound: 'Room «{room}» not found',
    pickRoom: 'Pick a room in the card settings',
    rooms: 'Rooms',
    house: 'House',
    system: 'System',
    noRooms: 'No rooms',

    st_heat: 'Heating', st_cool: 'Cooling', st_hold: 'Holding', st_wait: 'Waiting', st_window: 'Window',
    st_off: 'Off', st_frost: 'Frost guard', st_error: 'No data', st_monitor: 'Monitoring',

    openRoom: 'Open the room in Klimo',
    newTarget: 'New target',
    notSent: 'New target · not sent yet',
    notColder: 'Not colder than',
    notWarmer: 'Not warmer than',
    inRange: 'In range',
    windowPause: 'Paused · window',
    now: 'now {v}',
    sendIn: 'Sending in {n} s',
    closeIn: 'Closing in {n} s',
    release: 'Release to choose',
    dragHint: 'Drag along the arc — the value follows your finger',
    cancel: 'Cancel',
    undo: 'Undo · {n}',
    howLong: 'How long the new target lasts',
    until: 'until {t}',
    untilSlotEnd: 'until the slot ends',
    inProfile: 'in profile «{p}»',
    appliedTarget: 'Target {v} {u}',
    appliedRange: 'Range {v} {u}',
    manualLine: 'Manual {v} · {u}',
    updatedLine: '{p} (updated) · {u}',
    same: 'Same target — nothing to send',
    gapWarn: 'Bounds must stay {n}° apart',
    keepHeat: 'Keeps heating · {eta}, until {t}',
    startHeat: 'Starts heating · {eta}, until {t}',
    stopHeat: 'Heating stops · already {v}',
    noHeat: 'No heating needed · already {v}',
    heatTo: 'Heats to {v}, then holds',
    keepCool: 'Keeps cooling · {eta}, until {t}',
    startCool: 'Starts cooling · {eta}, until {t}',
    stopCool: 'Cooling stops · already {v}',
    noCool: 'No cooling needed · already {v}',
    coolTo: 'Cools to {v}, then holds',
    noChange: 'No change · within {lo}–{hi}',
    windowLater: 'Applies once the window is closed',
    windowResume: 'Resumes 2 min after the window closes',
    roomOn: 'The room turns on at {v}',
    boost: '{s}{n}° for {m} min',
    airing: 'Air for {m} min',
    airingStop: 'Stop airing',
    resume: 'Resume schedule',
    resumeHouse: 'Resume schedule for the whole house',
    houseResumed: 'The whole house follows the schedule again',
    turnOn: 'Turn the room on',
    ctl: 'Room control',
    ctl_schedule: 'Schedule',
    ctl_manual: 'Manual',
    ctl_off: 'Off',
    manualHold: 'Manual · not changed by the schedule',
    manualNote: 'Manual until you resume the schedule',
    manualHeld: 'Manual {v}',
    appliedManual: 'Target {v} · manual',
    offHold: 'Off · frost protection stays',
    locked: 'View only',
    minus: 'Lower the target by {n}°',
    plus: 'Raise the target by {n}°',
    minusBound: 'Lower {b} by {n}°',
    plusBound: 'Raise {b} by {n}°',
    boundLo: '«not colder»',
    boundHi: '«not warmer»',
    pickLo: 'Not colder than {v}. Select for −/+',
    pickHi: 'Not warmer than {v}. Select for −/+',
    slider: 'Room target',
    sliderLo: 'Lower bound',
    sliderHi: 'Upper bound',
    pager: 'Room {i} of {n}, swipe sideways',
    syncSending: 'Sending to {dev}…',
    syncSendingAny: 'Sending…',
    syncPartialTrv: '{a} of {n} valves confirmed…',
    syncPartialAc: 'Waiting for the air conditioner…',
    syncPartialMixed: '{a} of {n} confirmed…',
    syncDoneTrv1: 'The valve confirmed {v}',
    syncDoneTrv2: 'Both valves confirmed {v}',
    syncDoneTrvN: 'All {n} {heads} confirmed {v}',
    syncDoneAc: 'The air conditioner confirmed {v}',
    syncDoneMixed: 'Devices confirmed {v}',
    syncSaved: 'Saved: {v}',
    syncRetry: 'Retry {a}/{m}…',
    syncFailed: '{n} of {t} did not confirm · check the devices',
    devTrv: 'valves {a}/{n}',
    devAc: 'air conditioner',
    devMixed: 'air conditioner + {n} {heads}',
    devHeater: 'heater',
    devZone: 'floor valve',
    acc_heads: ['valve', 'valves', 'valves'],
    nom_heads: ['valve', 'valves', 'valves'],
    theAc: 'the air conditioner',
    acAndHeads: 'the air conditioner and {n} {heads}',
    degraded: 'Basic mode: the change lasts until the slot ends, no undo',
    failed: 'Failed: {e}',
    noReply: 'Klimo did not answer',
    undone: 'Restoring the previous target…',
    dur_slot: 'Until {t}',
    dur_slotOpen: 'Until the slot ends',
    dur_1h: '1 h',
    dur_2h: '2 h',
    dur_3h: '3 h',
    dur_morning: 'Until morning',
    dur_forever: 'Permanently',
    dur_manual: 'Until I resume the schedule',
    dur_none: 'No limit',

    seasonAuto: 'Auto · {s}',
    season_heating: 'heating',
    season_cooling: 'cooling',
    season_neutral: 'between seasons',
    modeHeat: 'Heating',
    modeCool: 'Cooling',
    modeOff: 'Off',
    seasonOf: '{s} season',
    seasonBetween: 'between seasons',
    change: 'Change',

    profileSheet: 'House profile',
    profileNow: 'now',
    duration: 'How long',
    consequences: 'What changes',
    pickProfile: 'Pick a profile or a duration',
    counting: 'Working out the consequences…',
    noPreview: 'Klimo did not answer — consequences unknown, you can still apply',
    apply: 'Apply',
    profileApplied: 'Profile «{p}» {u}',
    profileCleared: 'Schedule restored',
    frostOnly: 'frost guard only',

    triggers: 'Triggers:',
    schema: 'Schema and decision log',
    role_lead: 'lead',
    role_together: 'with the lead',
    role_reserve: 'reserve',
    role_assist: 'top-up',
    role_trigger_only: 'trigger only',
    role_room_primary: 'in the room',
    role_unused: 'not used',
    since: 'since {t}',
    sun: 'solar {v}',
    battery: 'battery {v}%',
    load: 'house {v}',
    kw: '{v} kW',
    w: '{v} W',

    close: 'Close',
    openKlimo: 'Open in Klimo',
    sensors: 'Sensors',
    why: 'Why',
    ignore30: 'Ignore 30 min',
    hide: 'Hide',
    moreIssues: 'and {n} more',
    e_temperature: 'Temperature',
    e_humidity: 'Humidity',
    e_dew_point: 'Dew point',
    e_target: 'Target',
    e_window: 'Window',
    e_heat_demand: 'Heat demand',
    e_cool_demand: 'Cool demand',
    on_window: 'open',
    off_window: 'closed',
    on_demand: 'yes',
    off_demand: 'no',
    unavailable: 'unavailable',

    min: '{n} min',
    hm: '{h} h {m} min',
    h: '{h} h',
    dh: '{d} d {h} h',
    lessMin: '<1 min',
    approx: '≈ {v}',

    ed_room: 'Room',
    ed_rooms: 'Rooms',
    ed_all: 'all',
    ed_variant: 'Layout',
    ed_card: 'card',
    ed_compact: 'row',
    ed_theme: 'Theme',
    ed_auto: 'like Home Assistant',
    ed_dark: 'dark',
    ed_light: 'light',
    ed_language: 'Language',
    ed_title: 'Title',
    ed_sort: 'Order',
    ed_controls: 'Controls',
    ed_direct: 'allowed',
    ed_lockedOpt: 'view only',
    ed_adminOnly: 'admins only',
    ed_sparkline: '6-hour chart',
    ed_issue: 'the issue instead of details',
    ed_meta: 'Details',
    ed_schedule: 'schedule strip',
    ed_metaRow: 'humidity, windows, devices',
    ed_profile: 'house profile',
    ed_attention: 'what needs attention',
    ed_profileChange: 'Profile change',
    ed_confirm: 'with confirmation',
    ed_navigate: 'open Klimo',
    ed_none: 'off',
    ed_tiles: 'Tiles',
    ed_sections: 'Sections',
    ed_sources: 'Sources',
    ed_step: 'Step',
    ed_roomStep: 'the room’s step',
    ed_quick: 'Quick actions',
    ed_durations: 'Durations',
    ed_defaultDuration: 'Default duration',
    ed_attentionFirst: 'attention first',
    ed_config: 'as in Klimo',
    ed_name: 'by name',
    ed_temperature: 'by temperature',
    ed_active: 'running only',
    k_humidity: 'humidity', k_window: 'window', k_device: 'device', k_source: 'source', k_pumps: 'pumps',
    k_outdoor: 'outdoor', k_sources: 'sources', k_circuits: 'circuits', k_energy: 'energy', k_triggers: 'triggers',
    k_boost: 'boost', k_airing: 'airing',
  },
};

/** Plural form: Ukrainian one / few / many; English uses `one` for 1 and `many` otherwise. */
function pl(lang, n, forms) {
  const [one, few, many] = forms;
  const a = Math.abs(Math.trunc(n));
  if (lang !== 'uk') return a === 1 ? one : many;
  if (a % 10 === 1 && a % 100 !== 11) return one;
  if (a % 10 >= 2 && a % 10 <= 4 && (a % 100 < 12 || a % 100 > 14)) return few;
  return many;
}

/** Dictionary lookup with `{name}` substitution; a missing key shows the key, never `undefined`. */
function tr(lang, key, vars) {
  const dict = STRINGS[lang] || STRINGS.uk;
  let s = dict[key];
  if (s === undefined) s = STRINGS.uk[key];
  if (typeof s !== 'string') return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/* ─────────────────────────────── 4 Helpers ─────────────────────────────────────────────────── */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** One decimal with a real minus sign: «19.8», «−2.0». */
function fmt1(v) {
  if (!isNum(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return (r < 0 ? '−' : '') + Math.abs(r).toFixed(1);
}

/** «19.8°», «—» when unknown. */
const fmtTemp = (v) => (isNum(v) ? `${fmt1(v)}°` : '—');

/** Decimals a target step needs: one, two for a 0.25 or 0.05 step, so every press shows. */
const stepDigits = (step) => Math.max(1, (String(step).split('.')[1] || '').length);

/** `d` decimals with a real minus sign. */
function fmtN(v, d) {
  if (!isNum(v)) return '—';
  const r = Number(v.toFixed(d));
  return (r < 0 ? '−' : '') + Math.abs(r).toFixed(d);
}

/** «20.0–24.5°» */
const fmtRange = (lo, hi) => `${fmt1(lo)}–${fmt1(hi)}°`;

/** The trend as the card prints it: «+0.4°/год», «−0.2°/год», «0.0°/год». */
function fmtTrend(v, lang) {
  const r = Math.round((v || 0) * 10) / 10;
  const sign = r > 0 ? '+' : r < 0 ? '−' : '';
  return `${sign}${Math.abs(r).toFixed(1)}${lang === 'uk' ? '°/год' : '°/h'}`;
}

function fmtPower(kw, lang) {
  if (!isNum(kw)) return '—';
  if (Math.abs(kw) < 1) return tr(lang, 'w', { v: Math.round(kw * 1000) });
  return tr(lang, 'kw', { v: fmt1(kw) });
}

/** «12 хв», «1 год 5 хв», «2 дн 3 год». */
function fmtDuration(minutes, lang) {
  const m = Math.round(Math.max(0, minutes));
  if (m < 1) return tr(lang, 'lessMin');
  if (m < 60) return tr(lang, 'min', { n: m });
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? tr(lang, 'hm', { h, m: r }) : tr(lang, 'h', { h });
  }
  const d = Math.floor(m / 1440);
  return tr(lang, 'dh', { d, h: Math.floor((m % 1440) / 60) });
}

const LOCALES = { uk: 'uk-UA', en: 'en-GB' };
const formatters = new Map();

function formatter(lang, tz, opts) {
  const key = `${lang}|${tz || ''}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(LOCALES[lang] || 'uk-UA', { ...opts, timeZone: tz || undefined });
    } catch {
      // an unknown time zone from a misconfigured HA: fall back to the browser's
      f = new Intl.DateTimeFormat(LOCALES[lang] || 'uk-UA', opts);
    }
    formatters.set(key, f);
  }
  return f;
}

/** «23:00»; more than a day away the weekday is added («пн 07:00»). */
function fmtClock(ts, lang, tz) {
  if (!isNum(ts)) return '';
  const time = formatter(lang, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
  if (Math.abs(ts - Date.now()) < 20 * 3600 * 1000) return time;
  return `${formatter(lang, tz, { weekday: 'short' }).format(ts)} ${time}`;
}

/** Local {weekday, minute of day} in the house's time zone. */
function localParts(ts, lang, tz) {
  const parts = formatter(lang, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  // on its own: next to a time Ukrainian puts the weekday in the accusative («у суботу»)
  const weekday = formatter(lang, tz, { weekday: 'long' }).format(ts);
  return {
    weekday: weekday.charAt(0).toUpperCase() + weekday.slice(1),
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Resolves the `{d}` / `{t}` placeholders of an add-on text against its `at`: `{d}` is the time
 * between now and `at` («12 хв»), `{t}` the clock time of `at` («23:00»). Texts never tick on
 * the wire; they tick here.
 */
function fill(text, at, lang, tz) {
  if (!text) return '';
  const s = String(text);
  if (s.indexOf('{') < 0) return s;
  const known = isNum(at);
  return s
    .replace(/\{d\}/g, () => (known ? fmtDuration(Math.abs(at - Date.now()) / 60000, lang) : ''))
    .replace(/\{t\}/g, () => (known ? fmtClock(at, lang, tz) : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const roundTo = (v, step) => Math.round(Math.round(v / step) * step * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sameNum = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) < 0.01;

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private window or locked-down browser: the card works without it */
  }
}

/* entity discovery ------------------------------------------------------------------------- */

// hass.states is a new object on every change; scans are cached per object so a missing entity
// does not cost a full scan of thousands of entities on every update
const scanCache = new WeakMap();

function scanStates(states, key, match) {
  let cache = scanCache.get(states);
  if (!cache) {
    cache = new Map();
    scanCache.set(states, cache);
  }
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const id of Object.keys(states)) {
    if (!id.startsWith('sensor.')) continue;
    const a = states[id] && states[id].attributes;
    if (a && match(a)) {
      found = id;
      break;
    }
  }
  cache.set(key, found);
  return found;
}

const isHubAttrs = (a) => !!a && a.kv === 'klimo' && Array.isArray(a.rooms);
const isRoomAttrs = (a) => !!a && a.kv === 'klimo_room' && !!a.th;
const isReplyAttrs = (a) => !!a && a.kv === 'klimo_reply' && Array.isArray(a.replies);

/**
 * The last good attributes of every Klimo entity. While the add-on is down HA keeps the entity
 * but drops its attributes; the cards keep showing the last data, greyed, with its age.
 */
const lastGood = new Map();

function readEntity(states, id, valid) {
  const st = id ? states[id] : null;
  if (!st) return null;
  const ok = valid(st.attributes);
  if (ok && st.state !== 'unavailable') {
    const prev = lastGood.get(id);
    if (!prev || prev.state !== st) lastGood.set(id, { state: st, attrs: st.attributes });
    return { id, st, attrs: st.attributes, live: true, since: null };
  }
  // the moment it went away is when the data stopped being current
  const gone = Date.parse(st.last_changed);
  const since = Number.isFinite(gone) ? gone : null;
  if (ok) return { id, st, attrs: st.attributes, live: false, since };
  const prev = lastGood.get(id);
  return { id, st, attrs: prev ? prev.attrs : null, live: false, since };
}

function findHubId(hass, config) {
  const states = hass.states;
  if (config.hub_entity && states[config.hub_entity]) return config.hub_entity;
  if (states['sensor.klimo_hub']) return 'sensor.klimo_hub';
  return scanStates(states, 'hub', isHubAttrs);
}

function readHub(hass, config) {
  const id = findHubId(hass, config);
  return id ? readEntity(hass.states, id, isHubAttrs) : null;
}

function findReplyId(hass) {
  if (hass.states['sensor.klimo_reply']) return 'sensor.klimo_reply';
  return scanStates(hass.states, 'reply', isReplyAttrs);
}

/** Klimo-looking entity ids, for the «waiting for data» hint. */
function klimoCandidates(hass) {
  return Object.keys(hass.states)
    .filter((id) => /^sensor\.klimo/.test(id))
    .slice(0, 4);
}

/**
 * `room:` accepts a slug, a room id or the room's climate entity. Resolution: the hub's room
 * list (id or slug) → `sensor.klimo_<slug>_card` → any entity with the room card shape.
 */
function resolveRoom(hass, ref, hubAttrs) {
  if (!ref) return null;
  const key = String(ref).trim();
  let slug = key;
  if (key.startsWith('climate.klimo_')) slug = key.slice('climate.klimo_'.length);
  else if (/^sensor\.klimo_.+_card$/.test(key)) slug = key.slice('sensor.klimo_'.length, -'_card'.length);
  let id = null;
  const rows = hubAttrs && Array.isArray(hubAttrs.rooms) ? hubAttrs.rooms : [];
  const row = rows.find((r) => r.id === key || r.s === key || r.s === slug);
  if (row) {
    slug = row.s;
    id = row.id;
  }
  let cardId = `sensor.klimo_${slug}_card`;
  if (!hass.states[cardId] || !isRoomAttrs(hass.states[cardId].attributes)) {
    const found = scanStates(hass.states, `room:${key}:${slug}`, (a) => isRoomAttrs(a) && (a.id === key || a.slug === key || a.slug === slug));
    if (found) cardId = found;
    else if (!hass.states[cardId]) cardId = null;
  }
  const card = cardId ? readEntity(hass.states, cardId, isRoomAttrs) : null;
  if (card && card.attrs) {
    slug = card.attrs.slug || slug;
    id = card.attrs.id || id;
  }
  const climateId = hass.states[`climate.klimo_${slug}`] ? `climate.klimo_${slug}` : key.startsWith('climate.') && hass.states[key] ? key : null;
  return { key, slug, id, row: row || null, card, climateId };
}

/** Rooms of the hub in the order configured in Klimo. */
function hubRooms(hubAttrs) {
  const rows = hubAttrs && Array.isArray(hubAttrs.rooms) ? hubAttrs.rooms.slice() : [];
  return rows.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
}

/* commands and replies ------------------------------------------------------------------- */

let reqSeq = 0;
const newReqId = () => `c${Date.now().toString(36)}${(reqSeq++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Replies to card commands arrive in the attributes of `sensor.klimo_reply` (a ring of the last
 * eight). Every card feeds the registry the hass objects it receives; a waiter resolves when
 * its reqId shows up, or with null after the timeout.
 */
const Replies = {
  waiters: new Map(),
  seen: null,
  hass: null,
  observe(hass) {
    this.hass = hass;
    const id = findReplyId(hass);
    const st = id ? hass.states[id] : null;
    if (!st || st === this.seen) return;
    this.seen = st;
    const replies = isReplyAttrs(st.attributes) ? st.attributes.replies : [];
    for (const r of replies) {
      const w = r && this.waiters.get(r.reqId);
      if (w) {
        this.waiters.delete(r.reqId);
        clearTimeout(w.timer);
        w.resolve(r);
      }
    }
  },
  find(reqId) {
    const hass = this.hass;
    const id = hass ? findReplyId(hass) : null;
    const st = id ? hass.states[id] : null;
    const replies = st && isReplyAttrs(st.attributes) ? st.attributes.replies : [];
    return replies.find((r) => r && r.reqId === reqId) || null;
  },
  wait(reqId, timeoutMs) {
    const ready = this.find(reqId);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(reqId, { resolve, timer });
    });
  },
};

const REPLY_TIMEOUT_MS = 3000;

const hasMqtt = (hass) => !hass.services || !!(hass.services.mqtt && hass.services.mqtt.publish);

/**
 * Publishes a card command. The reqId is known at once (the thermostat matches device sync
 * against it); `done` resolves to {reply, error}: `reply` is null when Klimo did not answer in
 * time, `error` is set when the publish failed or Klimo refused the command.
 */
function sendCommand(hass, cmd, timeoutMs = REPLY_TIMEOUT_MS) {
  const reqId = newReqId();
  const body = { ...cmd, reqId, user: (hass.user && hass.user.id) || null };
  const waiting = Replies.wait(reqId, timeoutMs);
  const done = (async () => {
    try {
      await hass.callService('mqtt', 'publish', { topic: 'klimo/command', payload: JSON.stringify(body) });
    } catch (err) {
      return { reply: null, error: (err && err.message) || String(err) };
    }
    const reply = await waiting;
    return { reply, error: reply && !reply.ok ? reply.error || reply.code || 'error' : null };
  })();
  return { reqId, done };
}

async function command(hass, cmd, timeoutMs) {
  const { reqId, done } = sendCommand(hass, cmd, timeoutMs);
  return { reqId, ...(await done) };
}

/* navigation ------------------------------------------------------------------------------- */

function fire(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** Home Assistant's own in-app navigation. */
function haNavigate(path, replace = false) {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace } }));
}

/**
 * Opens a page of the Klimo panel. The panel is an ingress iframe on the same origin; it picks
 * up a fresh deep link from localStorage when it loads or becomes visible.
 */
function openKlimo(hubAttrs, route) {
  storageSet('klimo.deeplink', JSON.stringify({ route, ts: Date.now() }));
  const panel = hubAttrs && hubAttrs.panel;
  if (panel) haNavigate(panel.startsWith('/') ? panel : `/${panel}`);
  else console.warn('klimo-cards: the hub does not publish the panel path yet, cannot open Klimo');
}

/* theme ------------------------------------------------------------------------------------ */

function resolveScheme(hass, config) {
  if (config.theme === 'dark' || config.theme === 'light') return config.theme;
  const dm = hass && hass.themes ? hass.themes.darkMode : undefined;
  if (dm === true) return 'dark';
  if (dm === false) return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/**
 * The card palette as custom properties. With `theme: auto` the neutrals come from the HA
 * theme (so the cards sit naturally in any dashboard) with Klimo's values as fallback; tone,
 * profile and knob colours always stay Klimo's — orange and blue mean heat and cold.
 */
function paletteCss(scheme, followHa, radius) {
  const t = TOKENS[scheme] || TOKENS.dark;
  const ha = (name, fallback) => (followHa ? `var(${name}, ${fallback})` : fallback);
  const v = [
    `--k-s1:${followHa ? `var(--ha-card-background, var(--card-background-color, ${t.surface1}))` : t.surface1}`,
    `--k-s2:${ha('--secondary-background-color', t.surface2)}`,
    `--k-s3:${t.surface3}`,
    `--k-s4:${t.surface4}`,
    `--k-elev:${followHa ? `var(--card-background-color, ${t.surfaceElevated})` : t.surfaceElevated}`,
    `--k-shadow:${t.shadowElevated}`,
    `--k-bd:${followHa ? `var(--ha-card-border-color, var(--divider-color, ${t.border}))` : t.border}`,
    `--k-bd2:${t.borderStrong}`,
    `--k-div:${ha('--divider-color', t.divider)}`,
    `--k-ring:${t.ring}`,
    `--k-track:${t.track}`,
    `--k-dot:${t.dot}`,
    `--k-idle:${t.controlOff}`,
    `--k-t1:${ha('--primary-text-color', t.text1)}`,
    `--k-t2:${ha('--secondary-text-color', t.text2)}`,
    `--k-t3:${t.text3}`,
    `--k-tns:${t.textNeutralStrong}`,
    `--k-band:${t.band}`,
    `--k-scrim:${t.scrim}`,
    `--k-abg:${t.actionBg}`,
    `--k-afg:${t.actionFg}`,
    `--k-r:${followHa ? `var(--ha-card-border-radius, ${radius}px)` : `${radius}px`}`,
    `--k-bw:${followHa ? 'var(--ha-card-border-width, 1px)' : '1px'}`,
  ];
  for (const [name, tone] of Object.entries(t.tones)) {
    v.push(`--k-${name}-bg:${tone.bg}`, `--k-${name}-fg:${tone.fg}`, `--k-${name}-line:${tone.line}`, `--k-${name}-solid:${tone.solid}`, `--k-${name}-ink:${tone.ink}`);
  }
  return `:host{${v.join(';')}}`;
}

/** Schema-node tones map onto the base tones; the cards draw «wait» as the yellow warn tone. */
function baseTone(tone) {
  switch (tone) {
    case 'heat':
    case 'cool':
    case 'hold':
    case 'warn':
    case 'err':
    case 'off':
    case 'ok':
    case 'event':
      return tone;
    case 'wait':
      return 'warn';
    case 'idle':
      return 'off';
    case 'mixed':
      return 'hold';
    default:
      return 'hold';
  }
}

const toneVars = (tone) => `background:var(--k-${tone}-bg);color:var(--k-${tone}-fg)`;

/** Room chip: label key, tone, icon («мова станів»). Unknown states read as «Тримає». */
const ROOM_STATES = {
  heat: { tone: 'heat', icon: 'flame' },
  cool: { tone: 'cool', icon: 'snow' },
  hold: { tone: 'hold', icon: 'checkCircle' },
  wait: { tone: 'heat', icon: 'clock' },
  window: { tone: 'warn', icon: 'windowOpen' },
  off: { tone: 'off', icon: 'power' },
  frost: { tone: 'off', icon: 'shield' },
  error: { tone: 'err', icon: 'alert' },
  monitor: { tone: 'off', icon: 'eye' },
};

function roomState(st, stText, lang) {
  const key = ROOM_STATES[st] ? st : 'hold';
  return { key, ...ROOM_STATES[key], label: stText || tr(lang, `st_${key}`) };
}

/** Target-source line: icon, colour and weight by kind (the text itself comes from Klimo). */
const SOURCE_KINDS = {
  schedule: { icon: 'clock', color: 'var(--k-t3)', weight: 400 },
  profile_updated: { icon: 'clock', color: 'var(--k-t3)', weight: 400 },
  manual: { icon: 'hand', color: 'var(--k-t1)', weight: 500 },
  range: { icon: 'range', color: 'var(--k-t1)', weight: 500 },
  boost: { icon: 'bolt', color: 'var(--k-heat-line)', weight: 500 },
  window: { icon: 'pause', color: 'var(--k-warn-line)', weight: 500 },
  airing: { icon: 'airing', color: 'var(--k-warn-line)', weight: 500 },
  off: { icon: 'power', color: 'var(--k-t3)', weight: 400 },
  monitor: { icon: 'eye', color: 'var(--k-t3)', weight: 400 },
  frost: { icon: 'shield', color: 'var(--k-t3)', weight: 400 },
  presence: { icon: 'users', color: 'var(--k-t3)', weight: 400 },
  calendar: { icon: 'calendar', color: 'var(--k-t3)', weight: 400 },
  room_profile: { icon: 'layers', color: 'var(--k-t3)', weight: 400 },
  preheat: { icon: 'trendUp', color: 'var(--k-heat-line)', weight: 500 },
  no_data: { icon: 'alert', color: 'var(--k-err-line)', weight: 500 },
};

function sourceKind(kind, cooling) {
  const k = SOURCE_KINDS[kind] || SOURCE_KINDS.schedule;
  // a cooling boost is a blue one: orange always means heat
  if ((kind === 'boost' || kind === 'preheat') && cooling) return { ...k, color: 'var(--k-cool-line)' };
  return k;
}

const DEVICE_ICONS = { trv: 'radiator', radiator: 'radiator', floor: 'floor', trvfloor: 'floor', ac: 'ac', heater: 'convector', none: 'eye' };

/** Plural word forms from the dictionary ([one, few, many]). */
function forms(lang, key) {
  const v = (STRINGS[lang] || STRINGS.uk)[key];
  return Array.isArray(v) ? v : STRINGS.uk[key];
}

/* actions ---------------------------------------------------------------------------------- */

/** Sheets opened from cards live in document.body; every card forwards its hass to them. */
const OpenSheets = new Set();

/**
 * Runs a tap / hold / double-tap action: the standard Home Assistant actions plus
 * `klimo-room-sheet` (the room in a sheet over the dashboard) and `klimo-open` (the page in the
 * Klimo panel).
 */
function runAction(card, action, ctx) {
  if (!action || typeof action !== 'object' || !action.action || action.action === 'none') return;
  if (action.confirmation) {
    const text = typeof action.confirmation === 'object' && action.confirmation.text ? action.confirmation.text : null;
    if (text && !window.confirm(text)) return;
  }
  const hass = ctx.hass;
  switch (action.action) {
    case 'klimo-room-sheet':
      if (ctx.sheet) ctx.sheet();
      else if (ctx.route) openKlimo(ctx.hub, ctx.route);
      break;
    case 'klimo-open':
      openKlimo(ctx.hub, action.route || ctx.route || '#/');
      break;
    case 'navigate':
      if (action.navigation_path) haNavigate(action.navigation_path, !!action.navigation_replace);
      break;
    case 'url':
      if (action.url_path) window.open(action.url_path, action.new_tab === false ? '_self' : '_blank', 'noopener');
      break;
    case 'more-info': {
      const entityId = action.entity || ctx.entity;
      if (entityId) fire(card, 'hass-more-info', { entityId });
      break;
    }
    case 'toggle': {
      const entityId = action.entity || ctx.entity;
      if (entityId && hass) hass.callService('homeassistant', 'toggle', { entity_id: entityId });
      break;
    }
    case 'perform-action':
    case 'call-service': {
      const svc = action.perform_action || action.service;
      if (!svc || !hass || svc.indexOf('.') < 0) break;
      const [domain, service] = svc.split('.', 2);
      Promise.resolve(hass.callService(domain, service, action.data || action.service_data || {}, action.target)).catch((e) =>
        console.warn('klimo-cards: action failed', e),
      );
      break;
    }
    case 'fire-dom-event':
      fire(card, 'll-custom', action);
      break;
    default:
      console.warn(`klimo-cards: unsupported action «${action.action}»`);
  }
}

/**
 * Tap, hold (500 ms) and double tap on an element or on rows inside it. Taps survive a
 * re-render in the middle of a touch because they remember the row's key, not the node, and a
 * finger that moves (scrolling the dashboard) never triggers anything.
 */
function bindPress(el, h) {
  let down = null;
  let holdTimer = 0;
  let tapTimer = 0;
  let lastKey = null;
  const cancel = () => {
    clearTimeout(holdTimer);
    down = null;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    const key = h.key(e);
    if (key === null || key === undefined) return;
    down = { x: e.clientX, y: e.clientY, key, held: false };
    clearTimeout(holdTimer);
    if (h.hasHold(key)) {
      holdTimer = setTimeout(() => {
        if (!down) return;
        down.held = true;
        h.hold(down.key);
      }, 500);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (down && (Math.abs(e.clientX - down.x) > 10 || Math.abs(e.clientY - down.y) > 10)) cancel();
  });
  el.addEventListener('pointerup', () => {
    if (!down) return;
    clearTimeout(holdTimer);
    const { key, held } = down;
    down = null;
    if (held) return;
    if (h.hasDouble(key)) {
      if (tapTimer && lastKey === key) {
        clearTimeout(tapTimer);
        tapTimer = 0;
        lastKey = null;
        h.double(key);
      } else {
        clearTimeout(tapTimer);
        lastKey = key;
        tapTimer = setTimeout(() => {
          tapTimer = 0;
          lastKey = null;
          h.tap(key);
        }, 250);
      }
    } else h.tap(key);
  });
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') cancel();
  });
  // a long press on a phone otherwise opens the browser's context menu over the dashboard
  el.addEventListener('contextmenu', (e) => {
    if (h.key(e) !== null && h.hasHold(h.key(e))) e.preventDefault();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const key = h.key(e);
    if (key === null || key === undefined) return;
    e.preventDefault();
    h.tap(key);
  });
}

/* shared styles ------------------------------------------------------------------------------ */

const BASE_CSS = `
:host { display: block; }
*, *::before, *::after { box-sizing: border-box; }
ha-card {
  display: block; position: relative; container-type: inline-size; overflow: hidden;
  background: var(--k-s1); color: var(--k-t1);
  border: var(--k-bw) solid var(--k-bd); border-radius: var(--k-r);
  box-shadow: var(--ha-card-box-shadow, none);
  font-family: var(--ha-font-family-body, 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif);
  font-size: 14px; line-height: 1.4; font-variant-numeric: tabular-nums;
  -webkit-tap-highlight-color: transparent;
}
ha-card.bare { background: transparent; border: 0; box-shadow: none; border-radius: 0; overflow: visible; }
svg.i { flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; color: inherit; margin: 0; -webkit-tap-highlight-color: transparent; }
button:focus { outline: none; }
:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid var(--k-t1); outline-offset: 2px; }
[hidden] { display: none !important; }
.msg { display: flex; flex-direction: column; gap: 6px; padding: 16px; font-size: 13px; color: var(--k-t2); }
.msg b { color: var(--k-t1); font-weight: 600; font-size: 14px; }
.msg code { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; }
.banner { display: flex; align-items: center; gap: 6px; padding: 8px 12px; margin-bottom: 10px; border-radius: 10px;
  font-size: 12px; font-weight: 500; background: var(--k-off-bg); color: var(--k-off-fg); }
.stale .body { opacity: .55; filter: grayscale(.6); pointer-events: none; }
.chip { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap; }
.chip .dotc { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.mi { display: inline-flex; align-items: center; gap: 4px; min-width: 0; color: var(--k-t3); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 38px; padding: 0 14px;
  border-radius: 10px; border: 1px solid var(--k-bd2); background: transparent; color: var(--k-t1);
  font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.btn.fill { background: var(--k-s2); }
.btn.primary { background: var(--k-abg); color: var(--k-afg); border-color: transparent; }
.btn[disabled] { opacity: .4; cursor: default; }
@media (hover: hover) {
  .btn:not([disabled]):hover { background: var(--k-s3); }
  .btn.primary:not([disabled]):hover { background: var(--k-abg); filter: brightness(1.08); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;

/* ─────────────────────────────── 5 Base element ────────────────────────────────────────────── */

const sameList = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** innerHTML only when the markup changed: untouched nodes keep focus, hover and touches. */
function setHtml(el, html) {
  if (el.__khtml === html) return false;
  el.innerHTML = html;
  el.__khtml = html;
  return true;
}

/**
 * Common plumbing: shadow root, config, theme and language, and the re-render discipline. HA
 * calls `set hass` on every entity change in the house; a card re-renders only when one of
 * its own entities changed (compared by reference), when the theme flips, or once a minute so
 * `{d}`/`{t}` texts stay current.
 */
class KlimoBase extends HTMLElement {
  static get radius() {
    return 18;
  }

  static get shell() {
    return '<ha-card data-root></ha-card>';
  }

  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._sig = null;
    this._built = false;
    this._varsCss = '';
    this._tick = 0;
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    this._config = this._normalize({ ...config });
    this._sig = null;
    if (this._hass) this._update(true);
  }

  set hass(hass) {
    // the same object arrives again when a sheet forwards what a card already got
    if (!hass || hass === this._hass) return;
    this._hass = hass;
    Replies.observe(hass);
    for (const sheet of OpenSheets) if (sheet !== this && !sheet.contains(this)) sheet.hass = hass;
    this._update(false);
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    clearInterval(this._tick);
    this._tick = setInterval(() => this._minute(), 30000);
    if (this._hass && this._config) this._update(true);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    this._tick = 0;
  }

  /** Defaults and validation of the YAML options; throws on values HA should flag. */
  _normalize(config) {
    return config;
  }

  /** State objects (and scalars) this card depends on; a re-render happens when any differs. */
  _deps(ctx) {
    return [ctx.hub && ctx.hub.st];
  }

  _minute() {
    if (this._hass && this._config) this._update(true);
  }

  _ctx() {
    const hass = this._hass;
    const config = this._config;
    const hub = readHub(hass, config);
    const hubAttrs = hub && hub.attrs;
    let lang = config.language === 'uk' || config.language === 'en' ? config.language : null;
    if (!lang) lang = hubAttrs && (hubAttrs.lang === 'uk' || hubAttrs.lang === 'en') ? hubAttrs.lang : null;
    if (!lang) {
      const ha = String((hass.locale && hass.locale.language) || hass.language || 'en');
      lang = ha.startsWith('uk') ? 'uk' : 'en';
    }
    const tz = (hubAttrs && hubAttrs.tz) || (hass.config && hass.config.time_zone) || undefined;
    const scheme = resolveScheme(hass, config);
    const followHa = config.theme !== 'dark' && config.theme !== 'light';
    return { hass, config, hub, hubAttrs, lang, tz, scheme, followHa };
  }

  _update(force) {
    if (!this._config || !this._hass) return;
    const ctx = this._ctx();
    const sig = [...this._deps(ctx), ctx.scheme, ctx.lang];
    if (!force && sameList(sig, this._sig)) return;
    this._sig = sig;
    this._ensureShell();
    const css = paletteCss(ctx.scheme, ctx.followHa, this.constructor.radius);
    if (css !== this._varsCss) {
      this._vars.textContent = css;
      this._varsCss = css;
    }
    this._render(ctx);
  }

  _ensureShell() {
    if (this._built) return;
    this.shadowRoot.innerHTML = `<style>${BASE_CSS}${this.constructor.css || ''}</style><style class="vars"></style>${this.constructor.shell}`;
    this._vars = this.shadowRoot.querySelector('style.vars');
    this._card = this.shadowRoot.querySelector('[data-root]');
    this._built = true;
    this._shell();
  }

  /** One-time wiring on the persistent ha-card (listeners that must survive re-renders). */
  _shell() {}

  /**
   * Builds a stable skeleton once; `_section` then replaces only the parts whose markup
   * changed, so a button is never swapped out from under a finger by an unrelated update.
   */
  _skeleton(html) {
    // the skeleton carries translated labels: a new language builds a new one
    if (this._sk && this._sk.html === html && this._sk.root.parentNode === this._card) return;
    this._card.innerHTML = html;
    this._card.__khtml = null;
    this._sk = { html, root: this._card.firstElementChild };
    for (const n of this._card.querySelectorAll('[data-s]')) this._sk[n.dataset.s] = n;
  }

  _section(name, html) {
    const el = this._sk[name];
    el.hidden = !html;
    setHtml(el, html);
  }

  /** A whole-card message (waiting, not found): the skeleton is rebuilt next time. */
  _message(html) {
    this._sk = null;
    setHtml(this._card, html);
  }

  _render() {}

  /** The «waiting for Klimo» / «offline» / «not found» states shared by every card. */
  _missingHub(ctx) {
    const cands = klimoCandidates(ctx.hass);
    const found = cands.length ? `<span>${esc(tr(ctx.lang, 'waitingFound', { ids: cands.join(', ') }))}</span>` : '';
    return `<div class="msg"><b>${esc(tr(ctx.lang, 'waiting'))}</b>${found}<span>${esc(tr(ctx.lang, 'waitingHint'))}</span></div>`;
  }

  _offlineBanner(ctx, since) {
    const t = since ? fmtClock(since, ctx.lang, ctx.tz) : null;
    const text = t ? tr(ctx.lang, 'offlineSince', { t }) : tr(ctx.lang, 'offline');
    return `<div class="banner" role="status">${ic('offline', 14)}<span class="ell">${esc(text)}</span></div>`;
  }

  /** Klimo answers offline when the hub entity is gone or reports the HA link down. */
  _isOffline(ctx, entity) {
    if (!ctx.hub) return !(entity && entity.live);
    if (!ctx.hub.live) return true;
    if (ctx.hubAttrs && ctx.hubAttrs.online === false) return true;
    return !!entity && !entity.live;
  }

  _staleSince(ctx, entity) {
    return (entity && entity.since) || (ctx.hub && ctx.hub.since) || null;
  }

  getCardSize() {
    return 4;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: 'auto' };
  }
}

/* shared option checks ---------------------------------------------------------------------- */

function oneOf(config, key, allowed, fallback) {
  const v = config[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (!allowed.includes(v)) throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  return v;
}

function listOf(config, key, allowed, fallback) {
  const v = config[key];
  if (v === undefined || v === null) return fallback;
  const arr = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = arr.filter((x) => !allowed.includes(x));
  if (bad.length) throw new Error(`${key}: unknown ${bad.join(', ')} (allowed: ${allowed.join(', ')})`);
  return arr;
}

function bool(config, key, fallback) {
  const v = config[key];
  return v === undefined || v === null ? fallback : v !== false && v !== 'false';
}

function numberIn(config, key, lo, hi, fallback) {
  const v = config[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${key} must be a number between ${lo} and ${hi}`);
  return n;
}

function commonOptions(config) {
  return {
    ...config,
    theme: oneOf(config, 'theme', ['auto', 'dark', 'light'], 'auto'),
    language: oneOf(config, 'language', ['auto', 'uk', 'en'], 'auto'),
  };
}

/* ─────────────────────────────── 6 Room card ───────────────────────────────────────────────── */

/**
 * Everything a room row or card shows, from the room's card sensor when there is one and
 * from the hub's compact room list otherwise.
 */
function roomView(ctx, entity, row) {
  const a = entity && entity.attrs ? entity.attrs : null;
  const st = (a && a.st) || (row && row.st) || 'hold';
  const state = roomState(st, a && a.stText, ctx.lang);
  const name = (a && a.n) || (row && row.n) || (entity && entity.st && entity.st.attributes.friendly_name) || '';
  const t = a ? a.t : row ? row.t : null;
  const tg = a ? a.tg : row ? row.tg : null;
  const lo = a ? a.lo : null;
  const hi = a ? a.hi : null;
  const src = a && a.src ? a.src : null;
  const cooling = !!(a && a.th && a.th.mode === 'cool') || st === 'cool';
  const srcText = src ? fill(src.t, src.at, ctx.lang, ctx.tz) : '';
  let iss = null;
  if (a && a.iss) iss = { tone: a.iss.tone === 'err' ? 'err' : 'warn', icon: a.iss.i || 'alert', text: fill(a.iss.t, a.iss.at, ctx.lang, ctx.tz), more: a.iss.more || 0, id: a.iss.id || a.iss.incidentId || null };
  else if (!a && row && row.iss) iss = { tone: row.it === 'err' ? 'err' : 'warn', icon: row.it === 'err' ? 'alert' : 'info', text: fill(row.iss, row.at, ctx.lang, ctx.tz), more: 0, id: null };
  // the compact sub-line: the issue, else the pause, else «state · where the target comes from»
  let sub;
  if (iss) sub = iss.text;
  else if (st === 'window' && srcText) sub = srcText;
  else if (row && row.sub) sub = fill(row.sub, row.at, ctx.lang, ctx.tz);
  else sub = srcText ? `${state.label} · ${srcText}` : state.label;
  let target = '';
  if (isNum(tg)) target = `→ ${fmtTemp(tg)}`;
  else if (isNum(lo) && isNum(hi)) target = `→ ${fmtRange(lo, hi)}`;
  return {
    id: (a && a.id) || (row && row.id) || null,
    slug: (a && a.slug) || (row && row.s) || null,
    name,
    st,
    state,
    t,
    tg,
    lo,
    hi,
    tol: a && Array.isArray(a.tol) ? a.tol : [0.2, 0.2],
    trend: a ? a.tr : null,
    h: a ? a.h : null,
    hw: !!(a && a.hw),
    win: a ? a.win : null,
    dev: a ? a.dev : null,
    src,
    srcText,
    srcStyle: sourceKind(src ? src.k : 'schedule', cooling),
    iss,
    sp: a ? a.sp : null,
    stg: a ? a.stg : null,
    why: a ? a.why : null,
    sub,
    subColor: iss ? `var(--k-${iss.tone}-fg)` : 'var(--k-t3)',
    target,
    attrs: a,
  };
}

/** The 6-hour sparkline: stepped target band at sample midpoints, gaps break the line. */
function sparkline(v) {
  let pts = Array.isArray(v.sp) && v.sp.length > 1 ? v.sp.map((x) => (isNum(x) ? x : null)) : null;
  if (!pts || !pts.some(isNum)) pts = isNum(v.t) ? [v.t, v.t] : null;
  if (!pts) return '';
  const n = pts.length;
  const tg = Array.isArray(v.stg) && v.stg.length === n ? v.stg.map((x) => (isNum(x) ? x : null)) : null;
  const below = isNum(v.tol[0]) ? v.tol[0] : 0.2;
  const above = isNum(v.tol[1]) ? v.tol[1] : 0.2;
  const pool = pts.filter(isNum);
  if (tg) for (const x of tg) if (isNum(x)) pool.push(x - below, x + above);
  let lo = Math.min(...pool) - 0.15;
  let hi = Math.max(...pool) + 0.15;
  if (hi - lo < 0.3) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.15;
    hi = mid + 0.15;
  }
  const X = (i) => (i / (n - 1)) * 100;
  const Y = (y) => 37 - ((y - lo) / (hi - lo)) * 34;
  const mid = (i) => (X(i) + X(i + 1)) / 2;
  const f = (x) => x.toFixed(2);

  let line = '';
  let pen = false;
  for (let i = 0; i < n; i++) {
    if (!isNum(pts[i])) {
      pen = false;
      continue;
    }
    line += `${pen ? 'L' : 'M'}${f(X(i))} ${f(Y(pts[i]))} `;
    if (!pen && (i === n - 1 || !isNum(pts[i + 1]))) line += `L${f(X(i))} ${f(Y(pts[i]))} `;
    pen = true;
  }

  let band = '';
  if (tg) {
    let i = 0;
    while (i < n) {
      if (!isNum(tg[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && isNum(tg[j + 1])) j++;
      const xs = i === 0 ? 0 : mid(i - 1);
      const xe = j === n - 1 ? 100 : mid(j);
      band += `M${f(xs)} ${f(Y(tg[i] + above))}`;
      for (let k = i + 1; k <= j; k++) band += ` H${f(mid(k - 1))} V${f(Y(tg[k] + above))}`;
      band += ` H${f(xe)} V${f(Y(tg[j] - below))}`;
      for (let k = j - 1; k >= i; k--) band += ` H${f(mid(k))} V${f(Y(tg[k] - below))}`;
      band += ` H${f(xs)} Z `;
      i = j + 1;
    }
  }

  let last = n - 1;
  while (last > 0 && !isNum(pts[last])) last--;
  const tone = v.state.tone;
  const dot = `left:${f(X(last))}%;top:${f((Y(pts[last]) / 40) * 100)}%;background:var(--k-${tone}-line)`;
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">${band ? `<path class="band" d="${band.trim()}"/>` : ''}<path class="line" d="${line.trim()}" style="stroke:var(--k-${tone}-line)"/></svg><span class="end" style="${dot}"></span>`;
}

function stateChip(state, size = 26) {
  return `<span class="chip" style="height:${size}px;${toneVars(state.tone)}">${ic(state.icon, 14)}<span>${esc(state.label)}</span></span>`;
}

function issuePill(iss, lang) {
  const more = iss.more ? `<span class="more">${esc(tr(lang, 'moreIssues', { n: iss.more }))}</span>` : '';
  return `<span class="pill" style="${toneVars(iss.tone)}">${ic(iss.icon, 14)}<span class="ell">${esc(iss.text)}</span>${more}</span>`;
}

function metaItems(ctx, v, show) {
  const items = [];
  if (show.includes('humidity') && isNum(v.h)) {
    items.push(`<span class="mi" style="color:${v.hw ? 'var(--k-warn-fg)' : 'var(--k-t3)'}">${ic('droplet', 14)}${Math.round(v.h)}%</span>`);
  }
  if (show.includes('window') && v.win) {
    const open = !!v.win.o;
    items.push(`<span class="mi" style="color:${open ? 'var(--k-warn-fg)' : 'var(--k-t3)'}">${ic(open ? 'windowOpen' : 'windowClosed', 14)}${esc(fill(v.win.t, v.win.at, ctx.lang, ctx.tz))}</span>`);
  }
  if (show.includes('device') && v.dev && v.dev.t) {
    items.push(`<span class="mi">${ic(DEVICE_ICONS[v.dev.k] || 'radiator', 14)}<span class="ell">${esc(v.dev.t)}</span></span>`);
  }
  return items.join('');
}

/** aria-label of a room: «Вітальня: 19.8°, гріє, Ціль 20.0° · Дома до 23:00». */
function roomAria(v) {
  return `${v.name}: ${fmtTemp(v.t)}, ${v.state.label.toLowerCase()}${v.srcText ? `, ${v.srcText}` : ''}`;
}

function roomCardHtml(ctx, v, opts) {
  const trend = isNum(v.trend)
    ? `<span class="trend">${ic(v.trend > 0.05 ? 'trendUp' : v.trend < -0.05 ? 'trendDown' : 'trendFlat', 14)}${esc(fmtTrend(v.trend, ctx.lang))}</span>`
    : '';
  const src = v.srcText
    ? `<div class="src"><svg class="i" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="stroke:${v.srcStyle.color}"><path d="${ICONS[v.srcStyle.icon]}"/></svg><span class="ell" style="font-weight:${v.srcStyle.weight}">${esc(v.srcText)}</span></div>`
    : '<div class="src"></div>';
  const spark = opts.sparkline ? `<div class="spark">${sparkline(v)}</div>` : '';
  const foot = opts.issue && v.iss ? issuePill(v.iss, ctx.lang) : `<span class="meta">${metaItems(ctx, v, opts.meta)}</span>`;
  return `<div class="rc"><div class="hd"><span class="title ell">${esc(v.name)}</span>${stateChip(v.state)}</div><div class="val"><span class="temp">${esc(fmtTemp(v.t))}</span>${trend}</div>${src}${spark}<div class="foot">${foot}</div></div>`;
}

function compactRowHtml(v) {
  const dot = v.iss ? `<span class="idot" style="background:var(--k-${v.iss.tone}-line)"></span>` : '';
  return (
    `<div class="cr"><span class="ava" style="${toneVars(v.state.tone)}">${ic(v.state.icon, 18)}${dot}</span>` +
    `<span class="mid"><span class="title ell">${esc(v.name)}</span><span class="sub ell" style="color:${v.subColor}">${esc(v.sub)}</span></span>` +
    `<span class="right"><span class="temp">${esc(fmtTemp(v.t))}</span><span class="tg">${esc(v.target)}</span></span></div>`
  );
}

const ROOM_CSS = `
.rc { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.rc .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
.rc .title { font-size: 16px; font-weight: 600; }
.rc .val { display: flex; align-items: baseline; gap: 10px; min-height: 40px; }
.rc .temp { font-size: 40px; font-weight: 500; letter-spacing: -1.2px; line-height: 1; }
.rc .trend { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--k-t3); white-space: nowrap; }
.rc .src { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 18px; font-size: 13px; color: var(--k-t2); }
.rc .spark { position: relative; height: 40px; }
.rc .spark svg { display: block; width: 100%; height: 40px; overflow: visible; }
.rc .spark .band { fill: var(--k-band); }
.rc .spark .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.rc .spark .end { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; box-shadow: 0 0 0 2px var(--k-s1); }
.rc .foot { display: flex; align-items: center; min-height: 24px; min-width: 0; }
.pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 24px; padding: 0 8px; border-radius: 8px;
  font-size: 12px; font-weight: 500; }
.pill .more { flex: none; opacity: .8; }
.meta { display: flex; gap: 12px; min-width: 0; font-size: 12px; color: var(--k-t3); overflow: hidden; white-space: nowrap; }
.cr { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 14px; }
.cr .ava { position: relative; flex: none; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.cr .idot { position: absolute; top: -1px; right: -1px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--k-s1); }
.cr .mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cr .title { font-size: 15px; font-weight: 600; }
.cr .sub { font-size: 12px; }
.cr .right { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.cr .temp { font-size: 22px; font-weight: 500; letter-spacing: -.4px; line-height: 1.1; }
.cr .tg { font-size: 12px; color: var(--k-t3); min-height: 16px; }
.tap { cursor: pointer; transition: background-color .15s; }
@media (hover: hover) { .tap:hover { background: var(--k-s2); } .tap:hover .idot, .tap:hover .end { box-shadow: 0 0 0 2px var(--k-s2); } }
`;

/** Opens the room in a sheet over the dashboard. */
function openRoomSheet(from, ctx, ref) {
  const sheet = document.createElement('klimo-room-sheet');
  sheet.setConfig({
    room: ref,
    theme: ctx.config.theme,
    language: ctx.config.language,
    hub_entity: ctx.config.hub_entity,
  });
  sheet.opener = from;
  sheet.hass = ctx.hass;
  document.body.appendChild(sheet);
}

class KlimoRoomCard extends KlimoBase {
  static get radius() {
    return 16;
  }

  static get css() {
    return ROOM_CSS;
  }

  static getConfigElement() {
    return document.createElement('klimo-room-card-editor');
  }

  static getStubConfig(hass) {
    return { room: firstRoomSlug(hass) || '' };
  }

  _normalize(config) {
    const c = commonOptions(config);
    c.variant = oneOf(config, 'variant', ['card', 'compact'], 'card');
    c.show_sparkline = bool(config, 'show_sparkline', true);
    c.show_meta = listOf(config, 'show_meta', ['humidity', 'window', 'device'], ['humidity', 'window', 'device']);
    c.show_issue = bool(config, 'show_issue', true);
    c.tap_action = config.tap_action || { action: 'klimo-room-sheet' };
    c.hold_action = config.hold_action || { action: 'klimo-open' };
    c.double_tap_action = config.double_tap_action || { action: 'none' };
    return c;
  }

  _deps(ctx) {
    this._ref = resolveRoom(ctx.hass, this._config.room, ctx.hubAttrs);
    const r = this._ref;
    return [ctx.hub && ctx.hub.st, r && r.card && r.card.st, r && r.climateId ? ctx.hass.states[r.climateId] : null];
  }

  _shell() {
    const card = this._card;
    bindPress(card, {
      key: () => (this._ready ? 'room' : null),
      hasHold: () => this._config.hold_action.action !== 'none',
      hasDouble: () => this._config.double_tap_action.action !== 'none',
      tap: () => this._act(this._config.tap_action),
      hold: () => this._act(this._config.hold_action),
      double: () => this._act(this._config.double_tap_action),
    });
  }

  _act(action) {
    const ctx = this._ctx();
    const r = this._ref;
    const ref = (r && (r.slug || r.id)) || this._config.room;
    runAction(this, action, {
      hass: ctx.hass,
      hub: ctx.hubAttrs,
      entity: (r && r.climateId) || (r && r.card && r.card.id) || null,
      route: r && r.id ? `#/rooms/${r.id}` : '#/rooms',
      sheet: () => openRoomSheet(this, ctx, ref),
    });
  }

  _render(ctx) {
    const card = this._card;
    const r = this._ref;
    const compact = this._config.variant === 'compact';
    card.classList.remove('stale', 'tap');
    for (const a of ['role', 'tabindex', 'aria-label']) card.removeAttribute(a);
    this._ready = false;
    if (!this._config.room) {
      setHtml(card, `<div class="msg">${esc(tr(ctx.lang, 'pickRoom'))}</div>`);
      return;
    }
    const entity = r && r.card;
    if (!entity || !entity.attrs) {
      if (r && r.row) {
        // the hub knows the room but its card sensor is not there (yet): show what the hub has
        return this._paint(ctx, roomView(ctx, null, r.row), compact, false);
      }
      setHtml(card, ctx.hub ? `<div class="msg">${esc(tr(ctx.lang, 'roomNotFound', { room: this._config.room }))}</div>` : this._missingHub(ctx));
      return;
    }
    this._paint(ctx, roomView(ctx, entity, r.row), compact, this._isOffline(ctx, entity) ? this._staleSince(ctx, entity) || true : false);
  }

  _paint(ctx, v, compact, stale) {
    const card = this._card;
    this._ready = true;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', roomAria(v));
    card.classList.add('tap');
    card.classList.toggle('stale', !!stale);
    const banner = stale ? this._offlineBanner(ctx, stale === true ? null : stale) : '';
    const body = compact
      ? compactRowHtml(v)
      : roomCardHtml(ctx, v, { sparkline: this._config.show_sparkline, issue: this._config.show_issue, meta: this._config.show_meta });
    setHtml(card, `${banner ? `<div style="padding:10px 10px 0">${banner}</div>` : ''}<div class="body">${body}</div>`);
  }

  getCardSize() {
    return this._config && this._config.variant === 'compact' ? 1 : 4;
  }

  getGridOptions() {
    return this._config && this._config.variant === 'compact' ? { columns: 12, min_columns: 4, rows: 'auto' } : { columns: 6, min_columns: 4, rows: 'auto' };
  }
}

function firstRoomSlug(hass) {
  if (!hass) return null;
  const hub = readHub(hass, {});
  const rows = hubRooms(hub && hub.attrs);
  return rows.length ? rows[0].s : null;
}

/* ─────────────────────────────── 7 Rooms list ──────────────────────────────────────────────── */

/** attention_first: rooms with errors → open windows → warnings → working → the rest. */
function attentionRank(row) {
  if (row.it === 'err' || row.st === 'error') return 0;
  if (row.st === 'window') return 1;
  if (row.it === 'warn') return 2;
  if (row.st === 'heat' || row.st === 'cool' || row.st === 'wait') return 3;
  return 4;
}

const ROOMS_CSS = `${ROOM_CSS}
.list { display: flex; flex-direction: column; gap: 6px; }
.list.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.ltitle { padding: 4px 4px 2px; font-size: 13px; font-weight: 600; color: var(--k-t2); }
.item { background: var(--k-s1); border: var(--k-bw) solid var(--k-bd); border-radius: 14px; overflow: hidden; }
.list.cards .item { border-radius: 16px; }
.empty { padding: 12px 4px; font-size: 13px; color: var(--k-t3); }
`;

class KlimoRoomsCard extends KlimoBase {
  static get radius() {
    return 14;
  }

  static get css() {
    return ROOMS_CSS;
  }

  static getConfigElement() {
    return document.createElement('klimo-rooms-card-editor');
  }

  static getStubConfig() {
    return { rooms: 'all', variant: 'compact', sort: 'attention_first' };
  }

  _normalize(config) {
    const c = commonOptions(config);
    if (config.rooms !== undefined && config.rooms !== 'all' && !Array.isArray(config.rooms)) throw new Error('rooms must be «all» or a list of rooms');
    c.rooms = config.rooms === undefined ? 'all' : config.rooms;
    c.exclude = Array.isArray(config.exclude) ? config.exclude.map(String) : [];
    c.variant = oneOf(config, 'variant', ['compact', 'card'], 'compact');
    c.sort = oneOf(config, 'sort', ['attention_first', 'config', 'name', 'temperature'], 'attention_first');
    c.tap_action = config.tap_action || { action: 'klimo-room-sheet' };
    c.hold_action = config.hold_action || { action: 'klimo-open' };
    c.double_tap_action = config.double_tap_action || { action: 'none' };
    return c;
  }

  _deps(ctx) {
    this._rows = this._pick(ctx);
    return [ctx.hub && ctx.hub.st, ...this._rows.map((x) => x.ref && x.ref.card && x.ref.card.st)];
  }

  /** The configured rooms with their hub rows and card sensors, sorted. */
  _pick(ctx) {
    const c = this._config;
    const all = hubRooms(ctx.hubAttrs);
    let keys;
    if (c.rooms === 'all') keys = all.map((r) => r.s);
    else keys = c.rooms.map(String);
    const excluded = new Set(c.exclude);
    const out = [];
    for (const key of keys) {
      const ref = resolveRoom(ctx.hass, key, ctx.hubAttrs);
      if (!ref || excluded.has(ref.slug) || excluded.has(String(ref.id)) || excluded.has(key)) continue;
      if (!ref.row && !(ref.card && ref.card.attrs)) continue;
      out.push({ key: ref.slug || key, ref });
    }
    const rowOf = (x) => x.ref.row || { st: x.ref.card.attrs.st, it: x.ref.card.attrs.iss ? x.ref.card.attrs.iss.tone : null, ord: 0, n: x.ref.card.attrs.n, t: x.ref.card.attrs.t };
    const byOrder = (a, b) => (rowOf(a).ord ?? 0) - (rowOf(b).ord ?? 0);
    if (c.sort === 'attention_first') out.sort((a, b) => attentionRank(rowOf(a)) - attentionRank(rowOf(b)) || byOrder(a, b));
    else if (c.sort === 'name') out.sort((a, b) => String(rowOf(a).n || '').localeCompare(String(rowOf(b).n || ''), LOCALES[ctx.lang]));
    else if (c.sort === 'temperature') out.sort((a, b) => (isNum(rowOf(a).t) ? rowOf(a).t : Infinity) - (isNum(rowOf(b).t) ? rowOf(b).t : Infinity) || byOrder(a, b));
    else if (c.rooms === 'all') out.sort(byOrder);
    return out;
  }

  _shell() {
    const card = this._card;
    card.classList.add('bare');
    const keyOf = (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const item = path.find((n) => n && n.dataset && n.dataset.room !== undefined);
      return item ? item.dataset.room : null;
    };
    bindPress(card, {
      key: keyOf,
      hasHold: () => this._config.hold_action.action !== 'none',
      hasDouble: () => this._config.double_tap_action.action !== 'none',
      tap: (k) => this._act(k, this._config.tap_action),
      hold: (k) => this._act(k, this._config.hold_action),
      double: (k) => this._act(k, this._config.double_tap_action),
    });
  }

  _act(key, action) {
    const ctx = this._ctx();
    const ref = resolveRoom(ctx.hass, key, ctx.hubAttrs);
    runAction(this, action, {
      hass: ctx.hass,
      hub: ctx.hubAttrs,
      entity: (ref && ref.climateId) || (ref && ref.card && ref.card.id) || null,
      route: ref && ref.id ? `#/rooms/${ref.id}` : '#/rooms',
      sheet: () => openRoomSheet(this, ctx, key),
    });
  }

  _render(ctx) {
    const c = this._config;
    const title = c.title === undefined ? tr(ctx.lang, 'rooms') : c.title;
    const head = title ? `<div class="ltitle">${esc(title)}</div>` : '';
    if (!ctx.hub && !this._rows.length) {
      setHtml(this._card, `<div class="item">${this._missingHub(ctx)}</div>`);
      return;
    }
    const stale = this._isOffline(ctx, null) ? this._staleSince(ctx, null) || true : false;
    const banner = stale ? this._offlineBanner(ctx, stale === true ? null : stale) : '';
    const cards = c.variant === 'card';
    const items = this._rows.map(({ key, ref }) => {
      const v = roomView(ctx, ref.card && ref.card.attrs ? ref.card : null, ref.row);
      const body = cards ? roomCardHtml(ctx, v, { sparkline: true, issue: true, meta: ['humidity', 'window', 'device'] }) : compactRowHtml(v);
      return `<div class="item tap" data-room="${esc(key)}" role="button" tabindex="0" aria-label="${esc(roomAria(v))}">${body}</div>`;
    });
    const list = items.length ? `<div class="list${cards ? ' cards' : ''}">${items.join('')}</div>` : `<div class="empty">${esc(tr(ctx.lang, 'noRooms'))}</div>`;
    this._card.classList.toggle('stale', !!stale);
    setHtml(this._card, `${head}${banner}<div class="body">${list}</div>`);
  }

  getCardSize() {
    return 1 + (this._rows ? this._rows.length : 3);
  }
}

/* ─────────────────────────────── 8 Thermostat ──────────────────────────────────────────────── */

const DIAL_C = 628.32; // 2π·100
const DIAL_TRACK = 471.24; // 270° of it

/**
 * A thermostat model from the room's HA climate entity, for when the card sensor is missing
 * or MQTT publishing is not available: enough to show and set the target, nothing more.
 */
function thermostatFromClimate(climate) {
  const a = climate.attributes || {};
  const dual = isNum(a.target_temp_low) && isNum(a.target_temp_high) && !isNum(a.temperature);
  const modes = Array.isArray(a.hvac_modes) ? a.hvac_modes : [];
  const cool = climate.state === 'cool' || (climate.state !== 'heat' && modes.includes('cool') && !modes.includes('heat'));
  const mode = dual ? 'dual' : isNum(a.temperature) ? (cool ? 'cool' : 'heat') : 'none';
  const action = a.hvac_action;
  const band = { below: 0.2, above: 0.2 };
  let state = 'hold';
  if (climate.state === 'off') state = 'off';
  else if (!isNum(a.current_temperature)) state = 'error';
  else if (action === 'heating' || action === 'preheating') state = 'heat';
  else if (action === 'cooling') state = 'cool';
  return {
    roomId: null,
    mode,
    curC: isNum(a.current_temperature) ? a.current_temperature : null,
    t: dual ? null : isNum(a.temperature) ? a.temperature : null,
    lo: dual ? a.target_temp_low : null,
    hi: dual ? a.target_temp_high : null,
    gapC: 1,
    tol: band,
    tolCool: band,
    latches: { heat: state === 'heat', cool: state === 'cool' },
    rate: { heat: 1, cool: 1, confident: false },
    min: isNum(a.min_temp) ? a.min_temp : 5,
    max: isNum(a.max_temp) ? a.max_temp : 30,
    step: isNum(a.target_temp_step) ? a.target_temp_step : 0.5,
    profileId: null,
    slotEnd: null,
    next: null,
    override: null,
    profileUpdated: false,
    untils: {},
    strip: [],
    devices: { trv: 0, ac: 0, heater: 0, zone: 0 },
    quick: { boostDeltaC: 1, boostMin: 30, airingMin: 10 },
    locked: mode === 'none',
    state,
  };
}

const THERMO_CSS = `
.th { display: flex; flex-direction: column; gap: 12px; padding: 18px; touch-action: pan-y; }
ha-card.embedded { background: transparent; border: 0; box-shadow: none; border-radius: 0; }
ha-card.embedded .th { padding: 0; }
ha-card.embedded .th .name, ha-card.embedded .th .open { display: none; }
.th .hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.th .hl { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.th .name { font-size: 17px; font-weight: 600; }
.th .src { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; color: var(--k-t3); }
.th .open { flex: none; width: 40px; height: 40px; padding: 0; border-radius: 12px; border: 1px solid var(--k-bd); background: var(--k-s2);
  color: var(--k-t1); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.dots { display: flex; justify-content: center; gap: 6px; margin-top: -4px; }
.pd { position: relative; width: 6px; height: 6px; padding: 0; border: 0; border-radius: 3px; background: var(--k-dot); cursor: pointer;
  transition: width .15s; }
.pd::after { content: ''; position: absolute; inset: -9px -4px; }
.pd[aria-current='true'] { width: 18px; background: var(--k-t1); }
.dialwrap { container: dw / inline-size; }
.dial { position: relative; width: min(260px, 100%); aspect-ratio: 13 / 12; margin: 0 auto; container-type: inline-size; }
.ring { position: absolute; left: 0; top: 0; width: 100%; height: auto; overflow: visible; }
.ring .track { fill: none; stroke: var(--k-track); stroke-width: 14; stroke-linecap: round; }
.ring .arc { fill: none; stroke-width: 14; stroke-linecap: round; transition: stroke-opacity .15s; }
.ring .curm { fill: var(--k-t1); stroke: var(--k-s1); stroke-width: 2; }
.ring .knob { fill: #FFFFFF; stroke-width: 4; }
.ring .hit { fill: transparent; cursor: grab; touch-action: none; outline: none; }
.ring .hit:focus-visible { stroke: var(--k-t1); stroke-width: 2; }
.th.dragging .ring .hit { cursor: grabbing; }
.ctr { position: absolute; left: 16.92%; right: 16.92%; top: 24.17%; display: flex; flex-direction: column; align-items: center; gap: 2px;
  text-align: center; pointer-events: none; }
.act { font-size: min(13px, 5cqw); font-weight: 600; white-space: nowrap; }
.big { display: flex; align-items: flex-start; line-height: 1; color: var(--k-t1); }
.big .int { font-size: min(66px, 25.4cqw); font-weight: 400; letter-spacing: -2px; }
.big .col { display: flex; flex-direction: column; justify-content: space-between; height: min(58px, 22.3cqw); margin-left: 3px; padding-top: 4px;
  font-size: min(21px, 8.1cqw); font-weight: 500; }
.dual { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; pointer-events: auto; }
.bnd { min-width: min(74px, 28.5cqw); padding: 0 2px 3px; border: 0; border-bottom: 3px solid transparent; background: transparent;
  font-size: min(30px, 11.6cqw); font-weight: 500; letter-spacing: -.5px; line-height: 1.1; cursor: pointer; }
.bnd.lo { color: var(--k-heat-fg); }
.bnd.hi { color: var(--k-cool-fg); }
.bnd[aria-pressed='false'] { opacity: .6; }
.bnd.lo[aria-pressed='true'] { border-bottom-color: var(--k-heat-line); }
.bnd.hi[aria-pressed='true'] { border-bottom-color: var(--k-cool-line); }
.th.ro .bnd { cursor: default; }
.sep { width: 1px; height: 30px; background: var(--k-bd2); }
.nowt { font-size: min(13px, 5cqw); color: var(--k-t2); white-space: nowrap; }
.stp { width: 48px; height: 48px; padding: 0; border-radius: 50%; border: 1.5px solid var(--k-ring); background: transparent; color: var(--k-t1);
  display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.dial .stp { position: absolute; top: calc(85% - 24px); }
.dial .stp.minus { left: calc(36.92% - 24px); }
.dial .stp.plus { left: calc(63.08% - 24px); }
@media (hover: hover) { .stp:hover { background: var(--k-s2); } .th .open:hover { background: var(--k-s3); } }
.lockl { position: absolute; left: 0; right: 0; top: 80.8%; display: flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 12px; color: var(--k-t3); }
.mini { display: none; align-items: center; justify-content: space-between; gap: 8px; }
.mini .mv { display: flex; flex-direction: column; align-items: center; min-width: 0; }
.mini .mval { font-size: 30px; font-weight: 500; letter-spacing: -.5px; line-height: 1.1; }
.mini .mact { font-size: 12px; font-weight: 600; }
@container dw (max-width: 199px) { .dial { display: none; } .mini { display: flex; } }
.th.err .ring, .th.err .ctr, .th.err .mini { opacity: .45; }
.info { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 20px; margin-top: -6px; font-size: 13px; text-align: center; }
.hint { margin-top: -6px; font-size: 12px; color: var(--k-t3); text-align: center; }
.quick { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; min-height: 38px; }
.qa { display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--k-bd2);
  background: transparent; font-size: 13px; font-weight: 500; cursor: pointer; }
.qa[disabled] { opacity: .5; cursor: default; }
@media (hover: hover) { .qa:not([disabled]):hover { background: var(--k-s2); } }
.ctl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; padding: 3px; border-radius: 12px; background: var(--k-s2); }
.cb { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; height: 36px; padding: 0 8px; border: 0;
  border-radius: 9px; background: transparent; color: var(--k-t2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.cb[aria-checked='true'] { background: var(--k-t1); color: var(--k-s1); }
.cb[data-pending] { box-shadow: inset 0 0 0 1.5px var(--k-t2); }
.cb[disabled] { cursor: default; }
.cb[disabled]:not([aria-checked='true']) { opacity: .5; }
@media (hover: hover) { .cb:not([disabled]):not([aria-checked='true']):hover { background: var(--k-s3); color: var(--k-t1); } }
@container (max-width: 420px) { .cb svg { display: none; } }
.mnote { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 55%; font-size: 12px; font-weight: 600; color: var(--k-t2); }
.pend { display: flex; align-items: center; gap: 10px; min-height: 38px; }
.selw { position: relative; flex: none; display: inline-flex; }
.selw select { height: 38px; max-width: 150px; padding: 0 30px 0 12px; border-radius: 10px; border: 1px solid var(--k-bd2); background: var(--k-s2);
  color: var(--k-t1); font: inherit; font-size: 13px; font-weight: 600; appearance: none; -webkit-appearance: none; cursor: pointer; text-overflow: ellipsis; }
.selw svg { position: absolute; right: 10px; top: 12px; pointer-events: none; color: var(--k-t2); }
.cd { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.cdt { font-size: 12px; color: var(--k-t2); }
.bar { position: relative; height: 3px; border-radius: 2px; background: var(--k-s3); overflow: hidden; }
.bar span { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: var(--k-t2); transition: width .95s linear; }
.appl { display: flex; align-items: center; gap: 10px; min-height: 38px; }
.apt { flex: 1; font-weight: 500; }
.strip { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.sbar { position: relative; height: 22px; border-radius: 6px; overflow: hidden; background: var(--k-s2); }
.seg { position: absolute; top: 0; bottom: 0; border-right: 2px solid var(--k-s1); }
.nowm { position: absolute; top: -2px; bottom: -2px; width: 3px; margin-left: -1px; background: var(--k-t1); box-shadow: 0 0 0 2px var(--k-s1); }
.axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--k-t3); }
.tmeta { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 14px; font-size: 12px; color: var(--k-t3); }
@container (max-width: 240px) { .axis { display: none; } }
`;

const STEPPER_MINUS = '<svg class="i" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
const STEPPER_PLUS = '<svg class="i" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

const TARGET_DURATIONS = ['slot', '1h', '2h', '3h', 'morning', 'manual', 'forever'];
/** The room's control modes a card can pick ('temporary' comes from a time-limited change). */
const CONTROL_MODES = ['schedule', 'manual', 'off'];

class KlimoThermostatCard extends KlimoBase {
  static get css() {
    return THERMO_CSS;
  }

  static getConfigElement() {
    return document.createElement('klimo-thermostat-card-editor');
  }

  static getStubConfig(hass) {
    return { room: firstRoomSlug(hass) || '' };
  }

  constructor() {
    super();
    this._s = this._fresh();
    this._timers = {};
    this._idx = null;
    this._struct = null;
    this._m = null;
    this._c = null;
  }

  _fresh(sel = 'hi') {
    return { phase: 'view', sel, pv: null, dur: null, left: 0, drag: null, durFocus: false, applied: null, note: null, preview: null, busy: null, ctlBusy: null };
  }

  _normalize(config) {
    const c = commonOptions(config);
    if (config.rooms !== undefined && config.rooms !== 'all' && !Array.isArray(config.rooms)) throw new Error('rooms must be «all» or a list of rooms');
    c.rooms = config.rooms === 'all' ? 'all' : Array.isArray(config.rooms) ? config.rooms.map(String) : null;
    c.controls = oneOf(config, 'controls', ['direct', 'locked', 'admin_only'], 'direct');
    if (config.step !== undefined && config.step !== null && config.step !== '') {
      const st = Number(config.step);
      if (![0.1, 0.5, 1].includes(st)) throw new Error('step must be 0.1, 0.5 or 1');
      c.step = st;
    } else c.step = null;
    c.drag = oneOf(config, 'drag', ['knob_only', 'off'], 'knob_only');
    c.send_delay = numberIn(config, 'send_delay', 0, 10, 3);
    c.undo_seconds = numberIn(config, 'undo_seconds', 0, 30, 8);
    c.durations = listOf(config, 'durations', TARGET_DURATIONS, ['slot', '1h', '3h', 'manual', 'forever']);
    if (!c.durations.length) c.durations = ['slot'];
    c.default_duration = oneOf(config, 'default_duration', TARGET_DURATIONS, 'slot');
    if (!c.durations.includes(c.default_duration)) c.default_duration = c.durations[0];
    c.quick_actions = listOf(config, 'quick_actions', ['boost', 'airing'], ['boost', 'airing']);
    c.show_schedule = bool(config, 'show_schedule', true);
    c.show_meta = bool(config, 'show_meta', true);
    c._embedded = !!config._embedded;
    return c;
  }

  /* rooms ------------------------------------------------------------------------------------ */

  _keys(ctx) {
    const c = this._config;
    if (c.rooms === 'all') return hubRooms(ctx.hubAttrs).map((r) => r.s);
    if (Array.isArray(c.rooms) && c.rooms.length) return c.rooms;
    if (c.room) return [String(c.room)];
    const first = hubRooms(ctx.hubAttrs)[0];
    return first ? [first.s] : [];
  }

  _storeKey() {
    const c = this._config;
    return `klimo.thermostat.${Array.isArray(c.rooms) ? c.rooms.join(',') : c.rooms || c.room || ''}`;
  }

  _deps(ctx) {
    const keys = this._keys(ctx);
    this._keyList = keys;
    if (this._idx === null) {
      const saved = keys.length > 1 ? storageGet(this._storeKey()) : null;
      this._idx = Math.max(0, saved ? keys.indexOf(saved) : 0);
    }
    if (this._idx >= keys.length) this._idx = 0;
    this._ref = keys.length ? resolveRoom(ctx.hass, keys[this._idx], ctx.hubAttrs) : null;
    const r = this._ref;
    return [ctx.hub && ctx.hub.st, r && r.card && r.card.st, r && r.climateId ? ctx.hass.states[r.climateId] : null, ctx.hass.user, keys.join('|')];
  }

  _minute() {
    // never rebuild under a finger or during a countdown
    if (this._s.phase === 'view' && !this._s.drag) super._minute();
  }

  _go(i) {
    const n = this._keyList ? this._keyList.length : 0;
    if (n < 2 || this._s.phase !== 'view') return;
    this._idx = ((i % n) + n) % n;
    storageSet(this._storeKey(), this._keyList[this._idx]);
    this._clearTimers();
    this._s = this._fresh();
    this._update(true);
  }

  /* model ------------------------------------------------------------------------------------ */

  _model(ctx) {
    const r = this._ref;
    const a = r && r.card && r.card.attrs ? r.card.attrs : null;
    const climate = r && r.climateId ? ctx.hass.states[r.climateId] : null;
    const th = a ? a.th : climate ? thermostatFromClimate(climate) : null;
    if (!th) return null;
    const degraded = !!climate && (!a || !hasMqtt(ctx.hass));
    const c = this._config;
    const isAdmin = !!(ctx.hass.user && ctx.hass.user.is_admin);
    const st = a ? a.st : th.state;
    const stale = a ? this._isOffline(ctx, r.card) : false;
    const lockedByConfig = c.controls === 'locked' || (c.controls === 'admin_only' && !isAdmin);
    const dual = th.mode === 'dual';
    const min = isNum(th.min) ? th.min : 5;
    const max = isNum(th.max) && th.max > min ? th.max : min + 25;
    const lo = isNum(th.lo) ? th.lo : min;
    const hi = isNum(th.hi) ? th.hi : max;
    const profiles = ctx.hubAttrs && Array.isArray(ctx.hubAttrs.profiles) ? ctx.hubAttrs.profiles : [];
    const profile = profiles.find((p) => p.id === th.profileId) || null;
    // without the card sensor the room thermostat says it: auto = schedule, off = off, heat/cool = manual
    const ctl = a ? (typeof a.ctl === 'string' ? a.ctl : null) : climate ? (climate.state === 'auto' ? 'schedule' : climate.state === 'off' ? 'off' : 'manual') : null;
    return {
      key: r.key,
      roomId: (a && a.id) || th.roomId || (r && r.id),
      name: (a && a.n) || (r.row && r.row.n) || (climate && climate.attributes.friendly_name) || r.key,
      attrs: a,
      climate,
      climateId: r.climateId,
      th,
      st,
      dual,
      min,
      max,
      step: c.step || (isNum(th.step) && th.step > 0 ? th.step : 0.5),
      gap: isNum(th.gapC) ? th.gapC : 2,
      E: dual ? { lo, hi } : isNum(th.t) ? th.t : null,
      degraded,
      stale,
      lockedByConfig,
      readOnly: lockedByConfig || th.locked || th.mode === 'none' || st === 'monitor' || st === 'error' || stale,
      ctl,
      // the mode can change even while the dial is locked (a room that is off has no target to turn)
      ctlAllowed: !!ctl && !lockedByConfig && !stale && st !== 'monitor',
      profiles,
      profileName: profile ? profile.n : '',
      // what the room's own profile would ask for (the start of an edit while the room is off)
      profileTarget: profile ? (th.mode === 'cool' ? profile.cl : profile.h) : null,
    };
  }

  _structKey(ctx, m) {
    const c = this._config;
    return [m.key, m.th.mode, m.readOnly, m.ctlAllowed, m.degraded, (this._keyList || []).length, c.durations.join(), c.show_schedule, c.show_meta, ctx.lang, c._embedded].join('|');
  }

  /* render ----------------------------------------------------------------------------------- */

  _render(ctx) {
    this._c = ctx;
    this._card.classList.toggle('embedded', !!this._config._embedded);
    const m = this._ref ? this._model(ctx) : null;
    if (!m) {
      if (this._s.phase !== 'view') this._clearTimers();
      this._s = this._fresh();
      this._m = null;
      this._struct = null;
      let msg;
      if (!this._keyList || !this._keyList.length) msg = ctx.hub ? `<div class="msg">${esc(tr(ctx.lang, 'pickRoom'))}</div>` : this._missingHub(ctx);
      else if (!ctx.hub) msg = this._missingHub(ctx);
      else msg = `<div class="msg">${esc(tr(ctx.lang, 'roomNotFound', { room: this._keyList[this._idx] }))}</div>`;
      setHtml(this._card, msg);
      return;
    }
    // a room that turned read-only mid-edit (locked, offline) drops the edit
    if (m.readOnly && this._s.phase === 'pending') {
      this._clearTimers();
      this._s = this._fresh(this._s.sel);
    }
    this._m = m;
    const key = this._structKey(ctx, m);
    const busy = this._s.phase !== 'view' || !!this._s.drag;
    if (key !== this._struct && (!busy || !this._el)) {
      this._struct = key;
      this._build(ctx, m);
    }
    this._patch();
  }

  _build(ctx, m) {
    const lang = ctx.lang;
    const keys = this._keyList || [];
    const dots =
      keys.length > 1
        ? `<div class="dots" role="group">${keys.map((k, i) => `<button type="button" class="pd" data-i="${i}"></button>`).join('')}</div>`
        : '';
    const durOptions = this._config.durations.map((d) => `<option value="${d}"></option>`).join('');
    const html = `
<div class="th body">
  <div class="hd">
    <div class="hl"><span class="name ell"></span><span class="src"><svg class="i srci" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path/></svg><span class="srct ell"></span></span></div>
    <button type="button" class="open" aria-label="${esc(tr(lang, 'openRoom'))}">${ic('settings', 18)}</button>
  </div>
  ${dots}
  <div class="dialwrap">
    <div class="dial">
      <svg class="ring" viewBox="0 0 260 260" aria-hidden="false">
        <circle class="track" cx="130" cy="130" r="100" stroke-dasharray="${DIAL_TRACK} ${DIAL_C}" transform="rotate(135 130 130)"/>
        <circle class="arc a" cx="130" cy="130" r="100"/>
        <circle class="arc b" cx="130" cy="130" r="100"/>
        <circle class="curm" r="4.5"/>
        <circle class="halo a" r="19"/><circle class="knob a" r="11"/>
        <circle class="halo b" r="19"/><circle class="knob b" r="11"/>
        <circle class="hit a" data-w="a" r="24" role="slider" tabindex="0"/>
        <circle class="hit b" data-w="b" r="24" role="slider" tabindex="0"/>
      </svg>
      <div class="ctr">
        <span class="act"></span>
        <span class="big" aria-live="polite"><span class="int"></span><span class="col"><span>°</span><span class="dec"></span></span></span>
        <span class="dual"><button type="button" class="bnd lo" data-b="lo"></button><span class="sep"></span><button type="button" class="bnd hi" data-b="hi"></button></span>
        <span class="nowt"></span>
      </div>
      <button type="button" class="stp minus" data-step="-1">${STEPPER_MINUS}</button>
      <button type="button" class="stp plus" data-step="1">${STEPPER_PLUS}</button>
      <span class="lockl">${ic('lock', 14)}<span>${esc(tr(lang, 'locked'))}</span></span>
    </div>
    <div class="mini">
      <button type="button" class="stp minus" data-step="-1">${STEPPER_MINUS}</button>
      <span class="mv"><span class="mact"></span><span class="mval"></span></span>
      <button type="button" class="stp plus" data-step="1">${STEPPER_PLUS}</button>
    </div>
  </div>
  <div class="info" role="status"><svg class="i infoi" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path/></svg><span class="infot"></span></div>
  ${
    m.ctlAllowed
      ? `<div class="ctl" role="radiogroup" aria-label="${esc(tr(lang, 'ctl'))}">${CONTROL_MODES.map(
          (k) => `<button type="button" role="radio" class="cb" data-ctl="${k}">${ic(k === 'schedule' ? 'clock' : k === 'manual' ? 'hand' : 'power', 15)}<span class="ell">${esc(tr(lang, `ctl_${k}`))}</span></button>`,
        ).join('')}</div>`
      : ''
  }
  <div class="hint" hidden></div>
  <div class="quick"></div>
  <div class="pend" hidden>
    <span class="selw"><select aria-label="${esc(tr(lang, 'howLong'))}">${durOptions}</select>${ic('chevronDown', 14)}</span>
    <span class="mnote" hidden>${ic('hand', 15)}<span class="ell">${esc(tr(lang, 'manualNote'))}</span></span>
    <span class="cd"><span class="cdt ell"></span><span class="bar"><span></span></span></span>
    <button type="button" class="btn cancel">${esc(tr(lang, 'cancel'))}</button>
  </div>
  <div class="appl" hidden>${ic('check', 18)}<span class="apt ell"></span><button type="button" class="btn fill undo"></button></div>
  <div class="strip" hidden><div class="sbar"></div><div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>
  <div class="tmeta" hidden></div>
</div>`;
    this._card.innerHTML = html;
    this._card.__khtml = null;
    const q = (s) => this._card.querySelector(s);
    const qa = (s) => [...this._card.querySelectorAll(s)];
    this._el = {
      root: q('.th'),
      name: q('.name'),
      srci: q('.srci'),
      srct: q('.srct'),
      open: q('.open'),
      dots: qa('.pd'),
      dotsBox: q('.dots'),
      svg: q('.ring'),
      arcA: q('.arc.a'),
      arcB: q('.arc.b'),
      cur: q('.curm'),
      haloA: q('.halo.a'),
      haloB: q('.halo.b'),
      knobA: q('.knob.a'),
      knobB: q('.knob.b'),
      hitA: q('.hit.a'),
      hitB: q('.hit.b'),
      act: q('.act'),
      big: q('.big'),
      int: q('.int'),
      dec: q('.dec'),
      dual: q('.dual'),
      lo: q('.bnd.lo'),
      hi: q('.bnd.hi'),
      nowt: q('.nowt'),
      steps: qa('.stp'),
      lock: q('.lockl'),
      mact: q('.mact'),
      mval: q('.mval'),
      info: q('.info'),
      infoi: q('.infoi'),
      infot: q('.infot'),
      hint: q('.hint'),
      quick: q('.quick'),
      ctl: qa('.cb'),
      mnote: q('.mnote'),
      pend: q('.pend'),
      select: q('select'),
      cdt: q('.cdt'),
      bar: q('.bar span'),
      appl: q('.appl'),
      apt: q('.apt'),
      undo: q('.undo'),
      strip: q('.strip'),
      sbar: q('.sbar'),
      meta: q('.tmeta'),
    };
  }

  /* derived view ----------------------------------------------------------------------------- */

  /** The value shown on the dial: the edit, the value just sent, or the room's target. */
  _shown() {
    const s = this._s;
    if (s.phase === 'pending') return s.pv;
    if (s.phase === 'applied' && s.applied && !s.applied.error) return s.applied.value;
    return this._m.E;
  }

  _startValue() {
    const s = this._s;
    const m = this._m;
    if (s.phase === 'pending') return s.pv;
    if (s.phase === 'applied' && s.applied && !s.applied.error) return s.applied.value;
    if (m.E !== null) return m.E;
    const base = isNum(m.profileTarget) ? m.profileTarget : isNum(m.th.curC) ? m.th.curC : (m.min + m.max) / 2;
    return clamp(roundTo(base, m.step), m.min, m.max);
  }

  _adjust(v, which, delta) {
    const m = this._m;
    const r = (x) => roundTo(x, m.step);
    if (!m.dual) return clamp(r(v + delta), m.min, m.max);
    if (which === 'lo') return { lo: clamp(r(v.lo + delta), m.min, Math.max(m.min, v.hi - m.gap)), hi: v.hi };
    return { lo: v.lo, hi: clamp(r(v.hi + delta), Math.min(m.max, v.lo + m.gap), m.max) };
  }

  _place(v, which, x) {
    const m = this._m;
    if (!m.dual) return clamp(x, m.min, m.max);
    if (which === 'lo') return { lo: clamp(x, m.min, Math.max(m.min, v.hi - m.gap)), hi: v.hi };
    return { lo: v.lo, hi: clamp(x, Math.min(m.max, v.lo + m.gap), m.max) };
  }

  _sameValue(a, b) {
    if (a === null || b === null) return a === b;
    if (typeof a === 'number' || typeof b === 'number') return sameNum(a, b);
    return sameNum(a.lo, b.lo) && sameNum(a.hi, b.hi);
  }

  /** Nothing to send: the same value and, with a manual target active, the same duration. */
  _unchanged() {
    const s = this._s;
    const m = this._m;
    if (!this._sameValue(s.pv, m.E)) return false;
    const ov = m.th.override;
    return !(ov && ov.kind === 'room_target' && ov.duration !== s.dur);
  }

  _fmtValue(v) {
    if (v === null || v === undefined) return '—';
    const d = this._m ? stepDigits(this._m.step) : 1;
    return typeof v === 'number' ? `${fmtN(v, d)}°` : `${fmtN(v.lo, d)}–${fmtN(v.hi, d)}°`;
  }

  _untilOf(d) {
    const th = this._m.th;
    const u = th.untils && th.untils[d] !== undefined ? th.untils[d] : null;
    if (isNum(u)) return u;
    const now = Date.now();
    if (d === 'slot') return isNum(th.slotEnd) ? th.slotEnd : null;
    if (d === '1h') return now + 3600e3;
    if (d === '2h') return now + 7200e3;
    if (d === '3h') return now + 3 * 3600e3;
    return null;
  }

  _untilText(d) {
    const lang = this._c.lang;
    if (d === 'forever') return tr(lang, 'inProfile', { p: this._m.profileName });
    if (d === 'manual') return tr(lang, 'dur_manual').toLowerCase();
    const u = this._untilOf(d);
    if (isNum(u)) return tr(lang, 'until', { t: fmtClock(u, lang, this._c.tz) });
    return d === 'slot' ? tr(lang, 'untilSlotEnd') : '';
  }

  _durLabel(d) {
    const lang = this._c.lang;
    if (d === 'slot') {
      const u = this._untilOf('slot');
      return isNum(u) ? tr(lang, 'dur_slot', { t: fmtClock(u, lang, this._c.tz) }) : tr(lang, 'dur_slotOpen');
    }
    return tr(lang, `dur_${d}`);
  }

  _actionLabel(S) {
    const s = this._s;
    const m = this._m;
    const lang = this._c.lang;
    if (s.phase === 'pending') {
      const text = m.dual ? tr(lang, s.sel === 'lo' ? 'notColder' : 'notWarmer') : tr(lang, 'newTarget');
      return { text, color: 'var(--k-t1)' };
    }
    const label = (k) => (m.attrs && m.attrs.st === k && m.attrs.stText) || tr(lang, `st_${k}`);
    switch (m.st) {
      case 'window':
        return { text: tr(lang, 'windowPause'), color: 'var(--k-warn-fg)' };
      case 'off':
        return { text: label('off'), color: 'var(--k-t3)' };
      case 'monitor':
        return { text: label('monitor'), color: 'var(--k-t3)' };
      case 'error':
        return { text: label('error'), color: 'var(--k-err-fg)' };
      case 'frost':
        return { text: label('frost'), color: 'var(--k-t2)' };
      case 'wait':
        return { text: label('wait'), color: 'var(--k-heat-fg)' };
      default:
    }
    if (m.th.latches && m.th.latches.heat) return { text: label('heat'), color: 'var(--k-heat-fg)' };
    if (m.th.latches && m.th.latches.cool) return { text: label('cool'), color: 'var(--k-cool-fg)' };
    if (m.dual) return { text: tr(lang, 'inRange'), color: 'var(--k-t2)' };
    return { text: label('hold'), color: 'var(--k-t2)' };
  }

  /** «Продовжить гріти · ≈ 45 хв, до 19:55» — what the change will do, from the room's latch. */
  _consequence(S) {
    const m = this._m;
    const th = m.th;
    const s = this._s;
    const lang = this._c.lang;
    const tz = this._c.tz;
    const t2 = 'var(--k-t2)';
    if (this._unchanged()) return { text: tr(lang, 'same'), icon: 'checkCircle', color: t2 };
    if (m.dual && S.hi - S.lo <= m.gap + 0.001) return { text: tr(lang, 'gapWarn', { n: fmt1(m.gap).replace('.0', '') }), icon: 'gap', color: 'var(--k-warn-fg)' };
    if (m.st === 'window') return { text: tr(lang, 'windowLater'), icon: 'windowOpen', color: 'var(--k-warn-fg)' };
    if (m.st === 'off') return { text: tr(lang, 'roomOn', { v: this._fmtValue(S) }), icon: 'power', color: t2 };
    if (!isNum(th.curC)) return { text: '', icon: null, color: t2 };
    const cur = Math.round(th.curC * 10) / 10;
    const eps = 1e-6;
    const eta = (delta, rate) => {
      const r = isNum(rate) && rate > 0 ? rate : 1;
      const mins = Math.max(5, Math.round(((Math.abs(delta) / r) * 60) / 5) * 5);
      const text = fmtDuration(mins, lang);
      return { eta: th.rate && th.rate.confident ? text : tr(lang, 'approx', { v: text }), t: fmtClock(Date.now() + mins * 60000, lang, tz) };
    };
    const band = (b) => ({ below: b && isNum(b.below) ? b.below : 0.2, above: b && isNum(b.above) ? b.above : 0.2 });
    const heat = (p, bd, on, rate) => {
      const { below, above } = band(bd);
      if (cur <= p - below + eps) return { text: tr(lang, on ? 'keepHeat' : 'startHeat', eta(p + above - cur, rate)), icon: 'flame', color: 'var(--k-heat-fg)' };
      if (cur >= p + above - eps) return { text: tr(lang, on ? 'stopHeat' : 'noHeat', { v: fmtTemp(cur) }), icon: 'power', color: t2 };
      if (on) return { text: tr(lang, 'heatTo', { v: fmtTemp(p + above) }), icon: 'flame', color: 'var(--k-heat-fg)' };
      return { text: tr(lang, 'noChange', { lo: fmt1(p - below), hi: fmtTemp(p + above) }), icon: 'checkCircle', color: t2 };
    };
    const cool = (p, bd, on, rate) => {
      const { below, above } = band(bd);
      if (cur >= p + above - eps) return { text: tr(lang, on ? 'keepCool' : 'startCool', eta(cur - (p - below), rate)), icon: 'snow', color: 'var(--k-cool-fg)' };
      if (cur <= p - below + eps) return { text: tr(lang, on ? 'stopCool' : 'noCool', { v: fmtTemp(cur) }), icon: 'power', color: t2 };
      if (on) return { text: tr(lang, 'coolTo', { v: fmtTemp(p - below) }), icon: 'snow', color: 'var(--k-cool-fg)' };
      return { text: tr(lang, 'noChange', { lo: fmt1(p - below), hi: fmtTemp(p + above) }), icon: 'checkCircle', color: t2 };
    };
    const latches = th.latches || {};
    const rate = th.rate || {};
    if (m.dual) return s.sel === 'lo' ? heat(S.lo, th.tol, !!latches.heat, rate.heat) : cool(S.hi, th.tolCool, !!latches.cool, rate.cool);
    if (th.mode === 'cool') return cool(S, th.tol, !!latches.cool, rate.cool);
    return heat(S, th.tol, !!latches.heat, rate.heat);
  }

  /** Device sync of the change just sent, from the card sensor's `sync`. */
  _syncLine(applied) {
    const m = this._m;
    const lang = this._c.lang;
    const sync = m.attrs && m.attrs.sync;
    const v = this._fmtValue(applied.value);
    const dev = m.th.devices || {};
    const mine = sync && applied.reqId && sync.reqId === applied.reqId;
    const what = mine ? sync.what : dev.ac && dev.trv ? 'mixed' : dev.ac ? 'ac' : dev.trv ? 'trv' : 'none';
    const total = mine && sync.total ? sync.total : what === 'trv' ? dev.trv : what === 'ac' ? dev.ac : (dev.trv || 0) + (dev.ac || 0);
    const warn = { icon: 'sync', color: 'var(--k-warn-fg)' };
    const ok = { icon: 'check', color: 'var(--k-ok-fg)' };
    const sending = () => {
      let target;
      if (what === 'trv') target = `${total} ${pl(lang, total, forms(lang, 'acc_heads'))}`;
      else if (what === 'ac') target = tr(lang, 'theAc');
      else if (what === 'mixed') target = tr(lang, 'acAndHeads', { n: dev.trv, heads: pl(lang, dev.trv, forms(lang, 'acc_heads')) });
      return { text: target ? tr(lang, 'syncSending', { dev: target }) : tr(lang, 'syncSendingAny'), ...warn };
    };
    if (!mine) return what === 'none' ? { text: tr(lang, 'syncSaved', { v }), ...ok } : sending();
    switch (sync.phase) {
      case 'partial':
        if (what === 'trv') return { text: tr(lang, 'syncPartialTrv', { a: sync.acked, n: total }), ...warn };
        if (what === 'ac') return { text: tr(lang, 'syncPartialAc'), ...warn };
        return { text: tr(lang, 'syncPartialMixed', { a: sync.acked, n: total }), ...warn };
      case 'retry':
        return { text: tr(lang, 'syncRetry', { a: sync.attempt, m: sync.maxAttempts }), ...warn };
      case 'failed':
        return { text: tr(lang, 'syncFailed', { n: Math.max(0, total - sync.acked), t: total }), icon: 'alert', color: 'var(--k-err-fg)' };
      case 'done':
      case 'idle': {
        if (what === 'none') return { text: tr(lang, 'syncSaved', { v }), ...ok };
        if (what === 'ac') return { text: tr(lang, 'syncDoneAc', { v }), ...ok };
        if (what === 'mixed') return { text: tr(lang, 'syncDoneMixed', { v }), ...ok };
        if (total === 1) return { text: tr(lang, 'syncDoneTrv1', { v }), ...ok };
        if (total === 2) return { text: tr(lang, 'syncDoneTrv2', { v }), ...ok };
        return { text: tr(lang, 'syncDoneTrvN', { n: total, heads: pl(lang, total, forms(lang, 'nom_heads')), v }), ...ok };
      }
      default:
        return sending();
    }
  }

  /** «головки 2/2 ✓», «кондиціонер…» while confirming. */
  _deviceMeta() {
    const m = this._m;
    const lang = this._c.lang;
    const dev = m.th.devices || {};
    const sync = m.attrs && m.attrs.sync;
    const busy = sync && (sync.phase === 'sending' || sync.phase === 'partial' || sync.phase === 'retry');
    const failed = sync && sync.phase === 'failed';
    const coolish = m.th.mode === 'cool' || m.dual;
    const icon = dev.ac && (coolish || !dev.trv) ? 'ac' : dev.trv ? 'radiator' : dev.heater ? 'convector' : dev.zone ? 'floor' : null;
    if (!icon) return '';
    let text;
    if (dev.ac && dev.trv) text = tr(lang, 'devMixed', { n: dev.trv, heads: pl(lang, dev.trv, forms(lang, 'nom_heads')) });
    else if (dev.ac) text = tr(lang, 'devAc');
    else if (dev.trv) {
      const acked = busy || failed ? sync.acked : dev.trv;
      text = tr(lang, 'devTrv', { a: acked, n: sync && (busy || failed) && sync.total ? sync.total : dev.trv });
    } else if (dev.heater) text = tr(lang, 'devHeater');
    else text = tr(lang, 'devZone');
    if (busy) return `<span class="mi" style="color:var(--k-warn-fg)">${ic(icon, 14)}${esc(text)}…</span>`;
    if (failed) return `<span class="mi" style="color:var(--k-err-fg)">${ic(icon, 14)}${esc(text)}</span>`;
    return `<span class="mi">${ic(icon, 14)}${esc(text)} ✓</span>`;
  }

  _quickActions() {
    const m = this._m;
    const c = this._config;
    const lang = this._c.lang;
    const th = m.th;
    const out = [];
    const ov = th.override;
    const ctl = m.ctl;
    if (ctl) {
      // the control row picks the mode; «Повернути розклад» also ends a temporary change and a boost
      if (ctl !== 'schedule') out.push({ id: 'resume', icon: 'undo', label: tr(lang, 'resume') });
    } else if (ov && ov.kind === 'room_off') out.push({ id: 'on', icon: 'power', label: tr(lang, 'turnOn') });
    else if (ov && (ov.kind === 'room_target' || ov.kind === 'room_boost' || ov.kind === 'room_profile')) out.push({ id: 'resume', icon: 'undo', label: tr(lang, 'resume') });
    const canBoost = ctl ? ctl === 'schedule' || ctl === 'manual' : !ov;
    if (canBoost && !(ov && ov.kind === 'room_boost') && c.quick_actions.includes('boost') && th.mode !== 'none' && m.st !== 'off') {
      const q = th.quick || {};
      const delta = Math.abs(isNum(q.boostDeltaC) ? q.boostDeltaC : 1);
      const down = th.mode === 'cool' || m.dual;
      out.push({ id: 'boost', icon: 'bolt', label: tr(lang, 'boost', { s: down ? '−' : '+', n: fmt1(delta).replace(/\.0$/, ''), m: q.boostMin || 30 }) });
    }
    if (c.quick_actions.includes('airing')) {
      const airing = m.attrs && m.attrs.src && m.attrs.src.k === 'airing';
      out.push(airing ? { id: 'airing_stop', icon: 'airing', label: tr(lang, 'airingStop') } : { id: 'airing', icon: 'airing', label: tr(lang, 'airing', { m: (th.quick && th.quick.airingMin) || 10 }) });
    }
    return out;
  }

  /* patch: the only place that touches the DOM after the skeleton is built ------------------- */

  _patch() {
    const m = this._m;
    const el = this._el;
    if (!m || !el) return;
    const ctx = this._c;
    const lang = ctx.lang;
    const s = this._s;
    const th = m.th;
    const pending = s.phase === 'pending';
    const applied = s.phase === 'applied' && s.applied;
    const S = this._shown();
    const ro = m.readOnly;

    el.root.classList.toggle('ro', ro);
    el.root.classList.toggle('err', m.st === 'error');
    el.root.classList.toggle('dragging', !!s.drag);
    this._card.classList.toggle('stale', m.stale);

    // header
    el.name.textContent = m.name;
    let line;
    if (pending) line = { text: tr(lang, 'notSent'), icon: 'pencil', color: 'var(--k-t1)', text2: 'var(--k-t1)', weight: 500 };
    else if (applied && !applied.error) {
      line =
        applied.dur === 'forever'
          ? { text: tr(lang, 'updatedLine', { p: m.profileName, u: this._untilText('slot') }), icon: 'clock', color: 'var(--k-t3)', text2: 'var(--k-t3)', weight: 400 }
          : applied.dur === 'manual'
            ? { text: tr(lang, 'manualHeld', { v: this._fmtValue(applied.value) }), icon: 'hand', color: 'var(--k-t1)', text2: 'var(--k-t2)', weight: 500 }
            : { text: tr(lang, 'manualLine', { v: this._fmtValue(applied.value), u: this._untilText(applied.dur) }), icon: 'hand', color: 'var(--k-t1)', text2: 'var(--k-t2)', weight: 500 };
    } else if (m.attrs && m.attrs.src) {
      const k = sourceKind(m.attrs.src.k, th.mode === 'cool');
      line = { text: fill(m.attrs.src.t, m.attrs.src.at, lang, ctx.tz), icon: k.icon, color: k.color, text2: k.weight > 400 ? 'var(--k-t2)' : 'var(--k-t3)', weight: k.weight };
    } else line = { text: m.climate ? m.climate.attributes.preset_mode || '' : '', icon: 'clock', color: 'var(--k-t3)', text2: 'var(--k-t3)', weight: 400 };
    if (m.stale) {
      const since = this._staleSince(ctx, this._ref.card);
      line = { text: since ? tr(lang, 'offlineSince', { t: fmtClock(since, lang, ctx.tz) }) : tr(lang, 'offline'), icon: 'offline', color: 'var(--k-t3)', text2: 'var(--k-t3)', weight: 500 };
    }
    el.srci.firstChild.setAttribute('d', ICONS[line.icon] || ICONS.clock);
    el.srci.style.stroke = line.color;
    el.srct.textContent = line.text;
    el.srct.style.color = line.text2;
    el.srct.style.fontWeight = String(line.weight);

    // pager (names only change with the room list, not under a dragging finger)
    if (el.dots.length && !s.drag) {
      const n = el.dots.length;
      el.dotsBox.setAttribute('aria-label', tr(lang, 'pager', { i: this._idx + 1, n }));
      el.dots.forEach((d, i) => {
        d.setAttribute('aria-current', String(i === this._idx));
        const ref = resolveRoom(ctx.hass, this._keyList[i], ctx.hubAttrs);
        d.setAttribute('aria-label', (ref && ref.row && ref.row.n) || this._keyList[i]);
      });
    }

    // dial
    const min = m.min;
    const max = m.max;
    const ang = (v) => 135 + (270 * (clamp(v, min, max) - min)) / (max - min);
    const pt = (v) => {
      const a = (ang(v) * Math.PI) / 180;
      return [130 + 100 * Math.cos(a), 130 + 100 * Math.sin(a)];
    };
    const latches = th.latches || {};
    const dim = m.st === 'window' || m.st === 'off' || m.st === 'error';
    const arc = (node, a0, a1, tone, on) => {
      node.setAttribute('stroke-dasharray', `${Math.max(0.01, (DIAL_C * (a1 - a0)) / 360).toFixed(2)} ${DIAL_C}`);
      node.setAttribute('transform', `rotate(${a0.toFixed(2)} 130 130)`);
      node.style.stroke = `var(--k-${tone}-line)`;
      node.style.strokeOpacity = on && !dim ? '1' : '0.45';
      node.style.visibility = 'visible';
    };
    const hide = (...nodes) => nodes.forEach((n) => (n.style.visibility = 'hidden'));
    const show = (...nodes) => nodes.forEach((n) => (n.style.visibility = 'visible'));
    const knob = (k, halo, hit, v, tone, which) => {
      const [x, y] = pt(v);
      for (const n of [k, halo, hit]) {
        n.setAttribute('cx', x.toFixed(2));
        n.setAttribute('cy', y.toFixed(2));
      }
      k.style.stroke = `var(--k-${tone}-line)`;
      halo.style.fill = `var(--k-${tone}-line)`;
      const active = (pending || s.drag) && (s.drag === which || (!s.drag && (m.dual ? s.sel === which : true)));
      halo.style.fillOpacity = active ? '0.25' : '0';
      show(k, halo);
      hit.style.visibility = 'visible';
      hit.style.pointerEvents = ro || this._config.drag === 'off' ? 'none' : 'all';
      hit.setAttribute('tabindex', ro ? '-1' : '0');
      hit.setAttribute('aria-disabled', String(ro));
      hit.setAttribute('aria-valuemin', String(min));
      hit.setAttribute('aria-valuemax', String(max));
      hit.setAttribute('aria-valuenow', String(v));
      hit.setAttribute('aria-valuetext', `${fmtN(v, stepDigits(m.step))}°`);
      hit.setAttribute('aria-label', tr(lang, which === 'lo' ? 'sliderLo' : which === 'hi' ? 'sliderHi' : 'slider'));
    };
    if (S === null || th.mode === 'none') {
      hide(el.arcA, el.arcB, el.knobA, el.haloA, el.knobB, el.haloB, el.hitA, el.hitB);
      for (const hit of [el.hitA, el.hitB]) {
        hit.style.pointerEvents = 'none';
        hit.setAttribute('tabindex', '-1');
      }
    } else if (m.dual) {
      arc(el.arcA, 135, ang(S.lo), 'heat', !!latches.heat);
      arc(el.arcB, ang(S.hi), 405, 'cool', !!latches.cool);
      knob(el.knobA, el.haloA, el.hitA, S.lo, 'heat', 'lo');
      knob(el.knobB, el.haloB, el.hitB, S.hi, 'cool', 'hi');
    } else {
      if (th.mode === 'cool') arc(el.arcA, ang(S), 405, 'cool', !!latches.cool);
      else arc(el.arcA, 135, ang(S), 'heat', !!latches.heat);
      knob(el.knobA, el.haloA, el.hitA, S, th.mode === 'cool' ? 'cool' : 'heat', 't');
      hide(el.arcB, el.knobB, el.haloB, el.hitB);
      el.hitB.style.pointerEvents = 'none';
      el.hitB.setAttribute('tabindex', '-1');
    }
    if (isNum(th.curC)) {
      const [cx, cy] = pt(th.curC);
      el.cur.setAttribute('cx', cx.toFixed(2));
      el.cur.setAttribute('cy', cy.toFixed(2));
      show(el.cur);
    } else hide(el.cur);

    // centre
    const act = this._actionLabel(S);
    el.act.textContent = act.text;
    el.act.style.color = act.color;
    el.mact.textContent = act.text;
    el.mact.style.color = act.color;
    el.big.hidden = m.dual;
    el.dual.hidden = !m.dual;
    const digits = stepDigits(m.step);
    if (m.dual) {
      el.lo.textContent = fmtN(S.lo, digits);
      el.hi.textContent = fmtN(S.hi, digits);
      el.lo.setAttribute('aria-pressed', String(s.sel === 'lo'));
      el.hi.setAttribute('aria-pressed', String(s.sel === 'hi'));
      el.lo.setAttribute('aria-label', tr(lang, 'pickLo', { v: fmtTemp(S.lo) }));
      el.hi.setAttribute('aria-label', tr(lang, 'pickHi', { v: fmtTemp(S.hi) }));
      el.lo.disabled = ro;
      el.hi.disabled = ro;
    } else if (isNum(S)) {
      const [whole, frac] = fmtN(S, digits).split('.');
      el.int.textContent = whole;
      el.dec.textContent = `.${frac}`;
      el.big.querySelector('.col').style.visibility = 'visible';
    } else {
      el.int.textContent = '—';
      el.dec.textContent = '';
      el.big.querySelector('.col').style.visibility = 'hidden';
    }
    el.mval.textContent = this._fmtValue(S);
    el.nowt.textContent = tr(lang, 'now', { v: fmtTemp(th.curC) });

    // steppers
    const stepTxt = String(m.step);
    el.steps.forEach((b) => {
      b.hidden = ro;
      const up = b.dataset.step === '1';
      const label = m.dual
        ? tr(lang, up ? 'plusBound' : 'minusBound', { b: tr(lang, s.sel === 'lo' ? 'boundLo' : 'boundHi'), n: stepTxt })
        : tr(lang, up ? 'plus' : 'minus', { n: stepTxt });
      b.setAttribute('aria-label', label);
    });
    el.lock.hidden = !ro || m.st === 'error';

    // info line
    let info = null;
    if (pending) {
      if (s.drag) info = { text: tr(lang, 'dragHint'), icon: null, color: 'var(--k-t2)', weight: 500 };
      else if (s.preview && this._sameValue(s.preview.value, s.pv) && s.preview.dur === s.dur) {
        const p = s.preview.data;
        const at = isNum(p.until) ? p.until : isNum(p.etaMin) ? Date.now() + p.etaMin * 60000 : null;
        const main = fill(p.main, at, lang, ctx.tz);
        const chips = Array.isArray(p.chips) && p.chips.length ? ` · ${p.chips.map((x) => fill(x, at, lang, ctx.tz)).join(' · ')}` : '';
        const tone = baseTone(p.tone);
        info = { text: main + chips, icon: p.icon, color: tone === 'hold' || tone === 'off' ? 'var(--k-t2)' : `var(--k-${tone}-fg)`, weight: 500 };
      } else {
        const cq = this._consequence(S);
        info = { ...cq, weight: 500 };
      }
    } else if (applied) {
      if (applied.error) info = { text: tr(lang, 'failed', { e: applied.error }), icon: 'alert', color: 'var(--k-err-fg)', weight: 500 };
      else if (applied.degraded) info = { text: tr(lang, 'syncSaved', { v: this._fmtValue(applied.value) }), icon: 'check', color: 'var(--k-ok-fg)', weight: 500 };
      else info = { ...this._syncLine(applied), weight: 500 };
    } else if (s.note && s.note.until > Date.now()) info = { text: s.note.text, icon: s.note.icon, color: s.note.color, weight: 500 };
    else if (m.st === 'window') info = { text: tr(lang, 'windowResume'), icon: null, color: 'var(--k-t3)', weight: 400 };
    // under manual control or off the schedule's next change does not apply to the room
    else if (m.ctl === 'manual') info = { text: tr(lang, 'manualHold'), icon: null, color: 'var(--k-t2)', weight: 500 };
    else if (m.ctl === 'off') info = { text: tr(lang, 'offHold'), icon: null, color: 'var(--k-t3)', weight: 400 };
    else if (m.attrs && m.attrs.next) info = { text: fill(m.attrs.next.t, m.attrs.next.at, lang, ctx.tz), icon: null, color: 'var(--k-t3)', weight: 400 };
    else info = { text: '', icon: null, color: 'var(--k-t3)', weight: 400 };
    el.infoi.style.display = info.icon ? '' : 'none';
    if (info.icon) el.infoi.firstChild.setAttribute('d', ICONS[info.icon] || ICONS.info);
    el.infot.textContent = info.text;
    el.info.style.color = info.color;
    el.info.style.fontWeight = String(info.weight);

    el.hint.hidden = !m.degraded;
    if (m.degraded) el.hint.textContent = tr(lang, 'degraded');

    // quick actions
    const quick = !ro && !m.degraded && s.phase === 'view' ? this._quickActions() : [];
    el.quick.hidden = !quick.length;
    setHtml(
      el.quick,
      quick.map((q) => `<button type="button" class="qa" data-q="${q.id}"${s.busy === q.id ? ' disabled' : ''}>${ic(q.icon, 15)}${esc(q.label)}</button>`).join(''),
    );

    // control: schedule / manual / off (a temporary change shows as the schedule it returns to)
    if (el.ctl.length) {
      if (s.ctlBusy && m.ctl === s.ctlBusy) s.ctlBusy = null;
      const cur = s.ctlBusy || (m.ctl === 'temporary' ? 'schedule' : m.ctl);
      el.ctl.forEach((b) => {
        b.setAttribute('aria-checked', String(b.dataset.ctl === cur));
        b.toggleAttribute('data-pending', !!s.ctlBusy && b.dataset.ctl === s.ctlBusy);
        b.disabled = pending || !!s.drag || !!s.ctlBusy;
      });
    }

    // pending bar
    el.pend.hidden = !pending;
    if (pending) {
      const holds = s.dur === 'manual' && m.ctl === 'manual';
      el.select.parentElement.hidden = m.degraded || holds;
      el.mnote.hidden = m.degraded || !holds;
      for (const o of el.select.options) {
        const label = this._durLabel(o.value);
        if (o.textContent !== label) o.textContent = label;
      }
      if (el.select.value !== s.dur) el.select.value = s.dur;
      const left = clamp(s.left, 0, this._config.send_delay);
      el.cdt.textContent = s.drag ? tr(lang, 'release') : tr(lang, this._unchanged() ? 'closeIn' : 'sendIn', { n: left });
      const pct = s.drag || s.durFocus || !this._config.send_delay ? 100 : (left / this._config.send_delay) * 100;
      el.bar.style.width = `${pct.toFixed(1)}%`;
    }

    // applied bar
    const showApplied = !!applied && !applied.error;
    el.appl.hidden = !showApplied;
    if (showApplied) {
      const what = applied.dur === 'forever' ? tr(lang, 'inProfile', { p: m.profileName }) : this._untilText(applied.dur);
      el.apt.textContent =
        applied.dur === 'manual'
          ? tr(lang, 'appliedManual', { v: this._fmtValue(applied.value) })
          : tr(lang, m.dual ? 'appliedRange' : 'appliedTarget', { v: this._fmtValue(applied.value), u: what });
      el.appl.firstChild.style.stroke = 'var(--k-ok-line)';
      const undoable = !applied.degraded && this._config.undo_seconds > 0 && applied.left > 0;
      el.undo.hidden = !undoable;
      if (undoable) el.undo.textContent = tr(lang, 'undo', { n: applied.left });
    }

    // the day strip
    const strip = this._config.show_schedule && !m.degraded && Array.isArray(th.strip) ? th.strip : [];
    el.strip.hidden = !strip.length;
    if (strip.length) {
      const palette = TOKENS.profiles;
      const colorOf = (id) => {
        const i = m.profiles.findIndex((p) => p.id === id);
        if (i >= 0 && m.profiles[i].c) return m.profiles[i].c;
        return palette[Math.max(0, i) % palette.length].color;
      };
      const nowMin = localParts(Date.now(), lang, ctx.tz).minute;
      const segs = strip
        .map(([a, b, id]) => `<span class="seg" style="left:${((a / 1440) * 100).toFixed(3)}%;width:${(((b - a) / 1440) * 100).toFixed(3)}%;background:${esc(colorOf(id))}"></span>`)
        .join('');
      setHtml(el.sbar, `${segs}<span class="nowm" style="left:${((nowMin / 1440) * 100).toFixed(3)}%"></span>`);
    }

    // meta
    if (this._config.show_meta) {
      const a = m.attrs;
      const items = [];
      if (a && isNum(a.h)) items.push(`<span class="mi" style="color:${a.hw ? 'var(--k-warn-fg)' : 'var(--k-t3)'}">${ic('droplet', 14)}${Math.round(a.h)}%</span>`);
      if (a && a.win) {
        const open = !!a.win.o;
        items.push(`<span class="mi" style="color:${open ? 'var(--k-warn-fg)' : 'var(--k-t3)'}">${ic(open ? 'windowOpen' : 'windowClosed', 14)}${esc(fill(a.win.t, a.win.at, lang, ctx.tz))}</span>`);
      }
      items.push(this._deviceMeta());
      const html = items.join('');
      el.meta.hidden = !html;
      setHtml(el.meta, html);
    } else el.meta.hidden = true;
  }

  /* interaction ------------------------------------------------------------------------------ */

  _shell() {
    const card = this._card;
    card.addEventListener('click', (e) => this._onClick(e));
    card.addEventListener('change', (e) => {
      if (e.target && e.target.tagName === 'SELECT') this._onDuration(e.target.value);
    });
    card.addEventListener('focusin', (e) => {
      if (e.target && e.target.tagName === 'SELECT' && this._s.phase === 'pending') {
        // choosing the duration takes as long as it takes: the countdown waits
        this._s.durFocus = true;
        this._s.left = this._config.send_delay;
        this._patch();
      }
    });
    card.addEventListener('focusout', (e) => {
      if (e.target && e.target.tagName === 'SELECT' && this._s.durFocus) {
        this._s.durFocus = false;
        if (this._s.phase === 'pending') this._arm();
        this._patch();
      }
    });
    card.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    card.addEventListener('pointermove', (e) => this._onPointerMove(e));
    card.addEventListener('pointerup', (e) => this._onPointerUp(e));
    card.addEventListener('pointercancel', (e) => this._onPointerUp(e, true));
    card.addEventListener('keydown', (e) => this._onKey(e));
  }

  _target(e, sel) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.find((n) => n && n.matches && n.matches(sel)) || null;
  }

  _onClick(e) {
    const m = this._m;
    if (!m) return;
    const stepBtn = this._target(e, '[data-step]');
    if (stepBtn) return this._step(Number(stepBtn.dataset.step) * m.step);
    const bound = this._target(e, '[data-b]');
    if (bound) return this._pick(bound.dataset.b);
    if (this._target(e, '.cancel')) return this._cancel();
    if (this._target(e, '.undo')) return this._undo();
    const qa = this._target(e, '[data-q]');
    if (qa) return this._quick(qa.dataset.q);
    const cb = this._target(e, '[data-ctl]');
    if (cb) return this._setControl(cb.dataset.ctl);
    const dot = this._target(e, '.pd');
    if (dot) return this._go(Number(dot.dataset.i));
    if (this._target(e, '.open')) {
      const ctx = this._ctx();
      openKlimo(ctx.hubAttrs, m.roomId ? `#/rooms/${m.roomId}` : '#/rooms');
    }
    return undefined;
  }

  _enterPending(pv) {
    const s = this._s;
    if (s.phase !== 'pending') {
      this._clearTimers();
      const ov = this._m.th.override;
      const keep = ov && ov.kind === 'room_target' && this._config.durations.includes(ov.duration) ? ov.duration : null;
      // a room under manual control holds every new value: there is no length to choose
      const dur = this._m.ctl === 'manual' ? 'manual' : keep || this._config.default_duration;
      this._s = { ...this._fresh(s.sel), phase: 'pending', dur };
    }
    this._s.pv = pv;
    this._s.preview = null;
  }

  _step(delta) {
    const m = this._m;
    if (!m || m.readOnly) return;
    const from = this._startValue();
    this._enterPending(this._adjust(from, this._s.sel, delta));
    this._arm();
    this._schedulePreview();
    this._patch();
  }

  _pick(which) {
    const m = this._m;
    if (!m || m.readOnly || !m.dual) return;
    this._s.sel = which;
    if (this._s.phase === 'pending') {
      this._s.preview = null;
      this._arm();
      this._schedulePreview();
    }
    this._patch();
  }

  _onDuration(value) {
    const s = this._s;
    if (s.phase !== 'pending') return;
    s.dur = value;
    s.preview = null;
    this._arm();
    this._schedulePreview();
    this._patch();
  }

  _cancel() {
    this._clearTimers();
    this._s = this._fresh(this._s.sel);
    this._patch();
  }

  /** Pointer angle on the dial → value, snapped to the step; the gap at the bottom snaps to the nearer end. */
  _valueAt(e) {
    const m = this._m;
    const r = this._el.svg.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    let a = (Math.atan2(y, x) * 180) / Math.PI;
    if (a < 0) a += 360;
    let rel = a - 135;
    if (rel < 0) rel += 360;
    if (rel > 270) rel = rel > 315 ? 0 : 270;
    return roundTo(m.min + (rel / 270) * (m.max - m.min), m.step);
  }

  _onPointerDown(e) {
    const m = this._m;
    if (!m) return;
    const hit = this._target(e, '.hit');
    if (hit) {
      if (m.readOnly || this._config.drag === 'off' || e.button !== 0) return;
      e.preventDefault();
      try {
        hit.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety; dragging still works inside the card */
      }
      const which = m.dual ? (hit.dataset.w === 'a' ? 'lo' : 'hi') : 't';
      this._enterPending(this._startValue());
      if (m.dual) this._s.sel = which;
      this._s.drag = which;
      this._clear('count');
      this._clear('preview');
      this._patch();
      return;
    }
    // a horizontal swipe outside the controls switches rooms
    if (this._keyList && this._keyList.length > 1 && !this._target(e, 'button, select, .hit')) {
      this._swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
    }
  }

  _onPointerMove(e) {
    const s = this._s;
    if (!s.drag || !this._m) return;
    const x = this._valueAt(e);
    const next = this._place(s.pv, s.drag, x);
    if (!this._sameValue(next, s.pv)) {
      s.pv = next;
      this._patch();
    }
  }

  _onPointerUp(e, cancelled) {
    const s = this._s;
    if (s.drag) {
      s.drag = null;
      this._arm();
      this._schedulePreview();
      this._patch();
      return;
    }
    const sw = this._swipe;
    this._swipe = null;
    if (!sw || cancelled || sw.id !== e.pointerId) return;
    const dx = e.clientX - sw.x;
    const dy = e.clientY - sw.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) this._go(this._idx + (dx < 0 ? 1 : -1));
  }

  _onKey(e) {
    const hit = this._target(e, '.hit');
    const m = this._m;
    if (!hit || !m || m.readOnly) return;
    const which = m.dual ? (hit.dataset.w === 'a' ? 'lo' : 'hi') : 't';
    let delta = null;
    let abs = null;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        delta = m.step;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        delta = -m.step;
        break;
      case 'PageUp':
        delta = 1;
        break;
      case 'PageDown':
        delta = -1;
        break;
      case 'Home':
        abs = m.min;
        break;
      case 'End':
        abs = m.max;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (m.dual) this._s.sel = which;
    const from = this._startValue();
    const next = abs !== null ? this._place(from, which, abs) : this._adjust(from, which, delta);
    this._enterPending(next);
    if (m.dual) this._s.sel = which;
    this._arm();
    this._schedulePreview();
    this._patch();
  }

  /* timers ----------------------------------------------------------------------------------- */

  _clear(name) {
    const t = this._timers[name];
    if (t) {
      clearTimeout(t);
      clearInterval(t);
    }
    delete this._timers[name];
  }

  _clearTimers() {
    for (const name of Object.keys(this._timers)) this._clear(name);
  }

  /** (Re)starts the send countdown; every change restarts it. */
  _arm() {
    const s = this._s;
    this._clear('count');
    s.left = this._config.send_delay;
    if (s.left <= 0) {
      if (!s.drag && !s.durFocus) this._commit();
      return;
    }
    this._timers.count = setInterval(() => {
      const cur = this._s;
      if (cur.phase !== 'pending') return this._clear('count');
      if (cur.drag || cur.durFocus) return undefined;
      cur.left -= 1;
      if (cur.left <= 0) {
        this._clear('count');
        this._commit();
      } else this._patch();
      return undefined;
    }, 1000);
  }

  /** Asks Klimo what the pending change will do; the local estimate shows until it answers. */
  _schedulePreview() {
    this._clear('preview');
    const s = this._s;
    const m = this._m;
    if (!m || m.degraded || s.drag || s.phase !== 'pending' || this._unchanged() || !m.roomId) return;
    const value = s.pv;
    const dur = s.dur;
    this._timers.preview = setTimeout(async () => {
      delete this._timers.preview;
      const cmd = m.dual
        ? { action: 'room.preview_target', roomId: m.roomId, lo: value.lo, hi: value.hi, duration: dur }
        : { action: 'room.preview_target', roomId: m.roomId, value, duration: dur };
      const res = await command(this._hass, cmd);
      const cur = this._s;
      if (cur.phase !== 'pending' || cur.dur !== dur || !this._sameValue(cur.pv, value)) return;
      if (res.reply && res.reply.ok && res.reply.preview) {
        cur.preview = { value, dur, data: res.reply.preview };
        this._patch();
      }
    }, 500);
  }

  _note(text, icon, color, ms = 4000) {
    this._s.note = { text, icon, color, until: Date.now() + ms };
    this._clear('note');
    this._timers.note = setTimeout(() => {
      delete this._timers.note;
      this._patch();
    }, ms + 50);
    this._patch();
  }

  _toView() {
    this._clearTimers();
    this._s = this._fresh(this._s.sel);
    // the room may have changed structurally while we were busy
    this._update(true);
  }

  /* commands --------------------------------------------------------------------------------- */

  _commit() {
    const s = this._s;
    const m = this._m;
    if (s.phase !== 'pending' || !m) return;
    this._clear('count');
    this._clear('preview');
    if (this._unchanged()) {
      this._toView();
      return;
    }
    const value = s.pv;
    const dur = s.dur;
    const which = m.dual ? s.sel : 't';
    const hass = this._hass;
    if (m.degraded) {
      const data = { entity_id: m.climateId };
      if (m.dual) {
        data.target_temp_low = value.lo;
        data.target_temp_high = value.hi;
      } else data.temperature = value;
      const applied = { value, dur: 'slot', which, reqId: null, token: null, error: null, left: 0, degraded: true };
      this._s = { ...this._fresh(s.sel), phase: 'applied', applied };
      Promise.resolve(hass.callService('climate', 'set_temperature', data)).catch((err) => {
        if (this._s.applied === applied) {
          applied.error = (err && err.message) || String(err);
          this._patch();
        }
      });
      this._timers.applied = setTimeout(() => this._toView(), 4000);
      this._patch();
      return;
    }
    const cmd = m.dual
      ? { action: 'room.set_target', roomId: m.roomId, lo: value.lo, hi: value.hi, which, duration: dur }
      : { action: 'room.set_target', roomId: m.roomId, value, which: 't', duration: dur };
    const { reqId, done } = sendCommand(hass, cmd);
    const applied = { value, dur, which, reqId, token: null, error: null, left: this._config.undo_seconds, prev: m.th.override, degraded: false };
    this._s = { ...this._fresh(s.sel), phase: 'applied', applied };
    this._startUndo(applied);
    this._patch();
    done.then(({ reply, error }) => {
      if (this._s.applied !== applied) return;
      if (error) {
        applied.error = error;
        this._clear('undo');
        this._timers.applied = setTimeout(() => this._toView(), 4000);
      } else if (reply) applied.token = reply.revertToken || null;
      this._patch();
    });
  }

  _startUndo(applied) {
    this._clear('undo');
    if (this._config.undo_seconds <= 0) {
      this._timers.applied = setTimeout(() => this._toView(), 4000);
      return;
    }
    this._timers.undo = setInterval(() => {
      if (this._s.applied !== applied) return this._clear('undo');
      applied.left -= 1;
      if (applied.left <= 0) this._toView();
      else this._patch();
      return undefined;
    }, 1000);
  }

  /** Undo restores what was there before: server-side with the revert token, else by hand. */
  _undo() {
    const applied = this._s.applied;
    const m = this._m;
    if (!applied || !m) return;
    const hass = this._hass;
    const lang = this._c.lang;
    this._clearTimers();
    this._s = this._fresh(this._s.sel);
    let cmd;
    if (applied.token) cmd = { action: 'room.undo', roomId: m.roomId, revertToken: applied.token };
    else if (applied.prev && applied.prev.kind === 'room_target') {
      const p = applied.prev;
      cmd = isNum(p.lo) && isNum(p.hi)
        ? { action: 'room.set_target', roomId: m.roomId, lo: p.lo, hi: p.hi, duration: p.duration || 'slot' }
        : { action: 'room.set_target', roomId: m.roomId, value: p.valueC, which: 't', duration: p.duration || 'slot' };
    } else cmd = { action: 'room.resume_schedule', roomId: m.roomId };
    this._note(tr(lang, 'undone'), 'undo', 'var(--k-t2)', 3000);
    command(hass, cmd).then(({ error }) => {
      if (error) this._note(tr(lang, 'failed', { e: error }), 'alert', 'var(--k-err-fg)');
    });
  }

  /** Schedule / manual / off; without the card sensor through the room thermostat's hvac mode. */
  _setControl(mode) {
    const m = this._m;
    const s = this._s;
    if (!m || !m.ctlAllowed || s.phase !== 'view' || s.ctlBusy || !CONTROL_MODES.includes(mode)) return;
    // «За розкладом» while a temporary change runs still ends it
    if (mode === m.ctl) return;
    const lang = this._c.lang;
    s.ctlBusy = mode;
    // a new choice replaces whatever the last action said
    s.note = null;
    this._patch();
    const done = (error) => {
      if (error) {
        if (this._s.ctlBusy === mode) this._s.ctlBusy = null;
        this._note(tr(lang, 'failed', { e: error }), 'alert', 'var(--k-err-fg)');
        return;
      }
      // the choice stays shown until the room's data says so (or a few seconds pass)
      this._clear('ctl');
      this._timers.ctl = setTimeout(() => {
        if (this._s.ctlBusy !== mode) return;
        this._s.ctlBusy = null;
        this._patch();
      }, 4000);
      this._patch();
    };
    if (m.degraded) {
      const hvac = mode === 'schedule' ? 'auto' : mode === 'off' ? 'off' : m.dual ? 'heat_cool' : m.th.mode === 'cool' ? 'cool' : 'heat';
      Promise.resolve(this._hass.callService('climate', 'set_hvac_mode', { entity_id: m.climateId, hvac_mode: hvac })).then(
        () => done(null),
        (err) => done((err && err.message) || String(err)),
      );
      return;
    }
    command(this._hass, { action: 'room.set_control', roomId: m.roomId, mode }).then(({ reply, error }) => {
      if (!error && !reply) this._note(tr(lang, 'noReply'), 'info', 'var(--k-t2)', 3000);
      done(error);
    });
  }

  _quick(id) {
    const m = this._m;
    if (!m || m.readOnly) return;
    const th = m.th;
    const q = th.quick || {};
    let cmd = null;
    if (id === 'boost') {
      const delta = Math.abs(isNum(q.boostDeltaC) ? q.boostDeltaC : 1);
      cmd = { action: 'room.boost', roomId: m.roomId, deltaC: th.mode === 'cool' || m.dual ? -delta : delta, minutes: q.boostMin || 30 };
    } else if (id === 'airing') cmd = { action: 'room.airing', roomId: m.roomId, minutes: q.airingMin || 10 };
    else if (id === 'airing_stop') cmd = { action: 'room.airing_cancel', roomId: m.roomId };
    else if (id === 'resume') cmd = { action: 'room.resume_schedule', roomId: m.roomId };
    else if (id === 'on') cmd = { action: 'room.on', roomId: m.roomId };
    if (!cmd) return;
    const lang = this._c.lang;
    this._s.busy = id;
    this._patch();
    command(this._hass, cmd).then(({ reply, error }) => {
      this._s.busy = null;
      if (error) this._note(tr(lang, 'failed', { e: error }), 'alert', 'var(--k-err-fg)');
      else if (!reply) this._note(tr(lang, 'noReply'), 'info', 'var(--k-t2)', 3000);
      else this._patch();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // leaving the dashboard during the countdown still means «change it»; Cancel is the way out
    if (this._s.phase === 'pending' && !this._unchanged()) this._commit();
    this._clearTimers();
    if (this._s.phase !== 'view') this._s = this._fresh(this._s.sel);
  }

  getCardSize() {
    return 10;
  }
}

/* ─────────────────────────────── 9 House card ──────────────────────────────────────────────── */

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;
const safeColor = (c, fallback) => (typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : fallback);

/** The logo mark from the hub's brand colours (the tile stays dark in both themes). */
function logoMark(brand, size = 22) {
  const b = brand || {};
  const cold = safeColor(b.cold, '#4DA6FF');
  const warm = safeColor(b.warm, '#FF8A3D');
  const dot = safeColor(b.dot, '#F4F5F6');
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#15181C"/>` +
    `<path d="M9.28 22.72A9.5 9.5 0 0 1 16 6.5" fill="none" stroke="${cold}" stroke-width="3.4" stroke-linecap="round"/>` +
    `<path d="M16 6.5A9.5 9.5 0 0 1 22.72 22.72" fill="none" stroke="${warm}" stroke-width="3.4" stroke-linecap="round"/>` +
    `<circle cx="16" cy="6.5" r="2.7" fill="${dot}" stroke="#15181C" stroke-width="1.6"/></svg>`
  );
}

/** «Авто · опалення», «Охолодження», «Вимкнено». */
function seasonLabel(season, lang) {
  if (!season) return '';
  const cur = tr(lang, `season_${season.cur}`);
  switch (season.mode) {
    case 'heat':
      return tr(lang, 'modeHeat');
    case 'cool':
      return tr(lang, 'modeCool');
    case 'off':
      return tr(lang, 'modeOff');
    default:
      return tr(lang, 'seasonAuto', { s: cur });
  }
}

function seasonChip(season, lang) {
  if (!season) return '';
  const tone = baseTone(season.tone || (season.cur === 'heating' ? 'heat' : season.cur === 'cooling' ? 'cool' : 'hold'));
  const title = season.t ? ` title="${esc(season.t)}"` : '';
  return `<span class="chip" style="height:28px;${toneVars(tone)}"${title}><span class="dotc" style="background:var(--k-${tone}-line)"></span>${esc(seasonLabel(season, lang))}</span>`;
}

function toneDot(tone) {
  const t = baseTone(tone);
  if (t === 'hold') return 'var(--k-t2)';
  if (t === 'off') return 'var(--k-t3)';
  return `var(--k-${t}-line)`;
}

const HOUSE_CSS = `
.hc { display: flex; flex-direction: column; gap: 14px; padding: 18px; }
.hc .hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.hc .brand { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-weight: 600; color: var(--k-t2); }
.hc .brand svg { flex: none; }
.hl { display: flex; flex-direction: column; gap: 2px; }
.hl .head { font-size: 22px; font-weight: 600; letter-spacing: -.3px; line-height: 1.25; }
.hl .subl { font-size: 13px; color: var(--k-t3); }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.tile { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px; border-radius: 12px; background: var(--k-s2); }
.tile.wide { grid-column: span 2; }
.tile .tl { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--k-t3); min-width: 0; }
.tile .tv { font-size: 16px; font-weight: 600; }
.tile .ts { font-size: 12px; color: var(--k-t3); }
.dotc { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.pbox { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--k-bd); }
.prow { display: flex; align-items: center; gap: 12px; min-width: 0; }
.presume { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 999px;
  border: 1px solid var(--k-bd2); background: transparent; font-size: 13px; font-weight: 500; cursor: pointer; }
@media (hover: hover) { .presume:hover { background: var(--k-s2); } }
.pic { flex: none; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; }
.pm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pm .pn { font-weight: 600; }
.pm .ps { font-size: 12px; color: var(--k-t3); }
.prow .btn { min-height: 40px; border-radius: 12px; background: var(--k-s2); flex: none; }
.att { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 0 12px; border-radius: 12px; border: 0;
  background: var(--k-warn-bg); color: var(--k-warn-fg); font-weight: 500; text-align: left; cursor: pointer; }
.att span { flex: 1; }
.undo-bar { display: flex; align-items: center; gap: 10px; min-height: 40px; }
.undo-bar .ut { flex: 1; min-width: 0; font-weight: 500; }
.note { font-size: 13px; font-weight: 500; }
@container (max-width: 260px) { .prow { flex-wrap: wrap; } .prow .pm { flex-basis: calc(100% - 48px); } }
`;

class KlimoHouseCard extends KlimoBase {
  static get css() {
    return HOUSE_CSS;
  }

  static getConfigElement() {
    return document.createElement('klimo-house-card-editor');
  }

  static getStubConfig() {
    return { show_profile: true, profile_change: 'confirm', show_attention: true };
  }

  _normalize(config) {
    const c = commonOptions(config);
    c.show_profile = bool(config, 'show_profile', true);
    c.profile_change = oneOf(config, 'profile_change', ['confirm', 'navigate', 'none'], 'confirm');
    c.profile_durations = listOf(config, 'profile_durations', ['slot', '1h', '2h', '3h', 'morning', 'none'], ['slot', '2h', 'morning', 'none']);
    if (!c.profile_durations.length) c.profile_durations = ['slot'];
    c.show_attention = bool(config, 'show_attention', true);
    c.show_system = config.show_system === undefined ? null : listOf(config, 'show_system', ['source', 'pumps', 'humidity', 'outdoor'], []);
    return c;
  }

  _shell() {
    this._card.addEventListener('click', (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const btn = path.find((n) => n && n.dataset && n.dataset.act);
      if (btn) this._act(btn.dataset.act);
    });
  }

  _render(ctx) {
    const card = this._card;
    const h = ctx.hubAttrs;
    if (!h) {
      this._message(this._missingHub(ctx));
      return;
    }
    const lang = ctx.lang;
    const c = this._config;
    const stale = this._isOffline(ctx, null);
    card.classList.toggle('stale', stale);
    const house = h.house || {};
    const season = h.season || null;
    const now = localParts(Date.now(), lang, ctx.tz);
    const seasonWord = !season ? '' : season.cur === 'neutral' ? tr(lang, 'seasonBetween') : tr(lang, 'seasonOf', { s: tr(lang, `season_${season.cur}`) });
    const title = c.title === undefined ? tr(lang, 'house') : c.title;
    this._skeleton(
      '<div class="hc"><div data-s="banner" hidden></div><div class="body hc" style="padding:0">' +
        '<div class="hd" data-s="hd"></div><div class="hl" data-s="hl"></div><div data-s="tiles" hidden></div><div data-s="profile" hidden></div>' +
        '<div class="undo-bar" data-s="undo" hidden><svg class="i uic" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path/></svg>' +
        '<span class="ut ell"></span><button type="button" class="btn fill" data-act="undo" hidden></button></div>' +
        '<div data-s="att" hidden></div></div></div>',
    );
    this._section('banner', stale ? this._offlineBanner(ctx, this._staleSince(ctx, null)) : '');
    this._section('hd', `<span class="brand">${logoMark(h.brand)}<span class="ell">${esc(title)}</span></span>${seasonChip(season, lang)}`);
    this._section(
      'hl',
      `<span class="head">${esc(fill(house.head, house.at, lang, ctx.tz))}</span><span class="subl ell">${esc([now.weekday, now.time, seasonWord].filter(Boolean).join(' · '))}</span>`,
    );
    this._section('tiles', this._tiles(ctx, house, season));
    this._section('profile', c.show_profile ? this._profileRow(ctx, h) : '');
    this._section(
      'att',
      c.show_attention && house.att > 0
        ? `<button type="button" class="att" data-act="attention">${ic('alert', 18)}<span class="ell">${esc(house.attText || `${house.att}`)}</span>${ic('chevronRight', 18)}</button>`
        : '',
    );
    this._patchUndo(lang);
  }

  _tiles(ctx, house, season) {
    const all = Array.isArray(house.tiles) ? house.tiles : [];
    let keys = this._config.show_system;
    if (!keys) keys = season && season.cur === 'cooling' ? ['source', 'humidity', 'outdoor'] : ['source', 'pumps', 'outdoor'];
    const tiles = keys.map((k) => all.find((t) => t && t.key === k)).filter(Boolean);
    if (!tiles.length) return '';
    const odd = tiles.length % 2 === 1;
    const html = tiles
      .map((t, i) => {
        let sub = fill(t.sub, t.at, ctx.lang, ctx.tz);
        if (!sub && t.key === 'source') sub = fill(house.sub, house.at, ctx.lang, ctx.tz);
        const wide = t.wide || (odd && i === 0);
        return (
          `<div class="tile${wide ? ' wide' : ''}">` +
          `<span class="tl"><span class="dotc" style="background:${toneDot(t.tone)}"></span><span class="ell">${esc(t.label)}</span></span>` +
          `<span class="tv ell">${esc(fill(t.value, t.at, ctx.lang, ctx.tz))}</span>${sub ? `<span class="ts ell">${esc(sub)}</span>` : ''}</div>`
        );
      })
      .join('');
    return `<div class="tiles">${html}</div>`;
  }

  _profileRow(ctx, h) {
    const hp = h.house && h.house.profile;
    if (!hp) return '';
    const profiles = Array.isArray(h.profiles) ? h.profiles : [];
    const i = profiles.findIndex((p) => p.id === hp.id);
    const p = i >= 0 ? profiles[i] : null;
    const pal = TOKENS.profiles[Math.max(0, i) % TOKENS.profiles.length];
    const bg = safeColor(p && p.c, pal.color);
    const ink = safeColor(p && p.k, pal.ink);
    // resuming the house is resuming everything (the house switch and button in Home Assistant do the same)
    const whole = typeof h.house.ctl === 'string';
    const overridden = hp.layer === 'house_manual' || h.house.ctl === 'manual';
    const resume = overridden
      ? `<button type="button" class="presume" data-act="resume">${ic('undo', 15)}${esc(tr(ctx.lang, whole ? 'resumeHouse' : 'resume'))}</button>`
      : '';
    const change = this._config.profile_change !== 'none' ? `<button type="button" class="btn" data-act="change">${esc(tr(ctx.lang, 'change'))}</button>` : '';
    return (
      `<div class="pbox"><div class="prow"><span class="pic" style="background:${bg};color:${ink}">${ic((p && p.i) || 'home', 18)}</span>` +
      `<span class="pm"><span class="pn ell">${esc(p ? p.n : hp.id)}</span><span class="ps ell">${esc(fill(hp.t, hp.until, ctx.lang, ctx.tz))}</span></span>` +
      `${change}</div>${resume}</div>`
    );
  }

  /** The confirmation line after a profile change; patched in place while the undo counts down. */
  _patchUndo(lang) {
    const el = this._sk.undo;
    const u = this._applied;
    el.hidden = !u;
    if (!u) return;
    const icon = el.querySelector('.uic');
    const text = el.querySelector('.ut');
    const btn = el.querySelector('[data-act="undo"]');
    icon.firstChild.setAttribute('d', ICONS[u.error ? 'alert' : 'check']);
    icon.style.stroke = u.error ? 'var(--k-err-line)' : 'var(--k-ok-line)';
    text.textContent = u.error ? tr(lang, 'failed', { e: u.error }) : u.text;
    text.style.color = u.error ? 'var(--k-err-fg)' : '';
    const undoable = !u.error && !!u.token && u.left > 0;
    btn.hidden = !undoable;
    if (undoable) btn.textContent = tr(lang, 'undo', { n: u.left });
  }

  _act(act) {
    const ctx = this._ctx();
    const h = ctx.hubAttrs;
    if (act === 'attention') openKlimo(h, '#/');
    else if (act === 'change') {
      if (this._config.profile_change === 'navigate') openKlimo(h, '#/schedule');
      else this._openSheet(ctx);
    } else if (act === 'resume') {
      const whole = !!(h && h.house && typeof h.house.ctl === 'string');
      const cmd = whole ? { action: 'house.set_control', mode: 'schedule' } : { action: 'house.clear_profile' };
      command(ctx.hass, cmd).then(({ error }) => this._result(error, tr(ctx.lang, whole ? 'houseResumed' : 'profileCleared')));
    } else if (act === 'undo') {
      const u = this._applied;
      if (!u || !u.token) return;
      this._endUndo();
      command(ctx.hass, { action: 'house.undo', revertToken: u.token }).then(({ error }) => {
        if (error) this._result(error);
      });
    }
  }

  _openSheet(ctx) {
    const sheet = document.createElement('klimo-profile-sheet');
    sheet.setConfig({ theme: this._config.theme, language: this._config.language, hub_entity: this._config.hub_entity, durations: this._config.profile_durations });
    sheet.opener = this;
    sheet.onApply = (r) => this._watchApply(r);
    sheet.hass = ctx.hass;
    document.body.appendChild(sheet);
  }

  /** After «Застосувати»: the line with the new profile and an undo countdown once Klimo answers. */
  _watchApply({ done, text }) {
    this._endUndo();
    const u = { text, token: null, left: 8, error: null };
    this._applied = u;
    this._update(true);
    done.then(({ reply, error }) => {
      if (this._applied !== u) return;
      if (error) {
        u.error = error;
        this._timer = setTimeout(() => this._endUndo(), 5000);
      } else {
        u.token = reply ? reply.revertToken || null : null;
        this._timer = setInterval(() => {
          u.left -= 1;
          if (u.left <= 0) this._endUndo();
          else this._update(true);
        }, 1000);
      }
      this._update(true);
    });
  }

  _result(error, okText) {
    if (!error && !okText) return;
    this._endUndo();
    this._applied = error ? { error, text: '', token: null, left: 0 } : { text: okText, token: null, left: 0, error: null };
    this._timer = setTimeout(() => this._endUndo(), 4000);
    this._update(true);
  }

  _endUndo() {
    clearInterval(this._timer);
    clearTimeout(this._timer);
    this._timer = 0;
    if (this._applied) {
      this._applied = null;
      this._update(true);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._timer);
    clearTimeout(this._timer);
    this._applied = null;
  }

  getCardSize() {
    return 9;
  }
}

/* ─────────────────────────────── 10 System card ────────────────────────────────────────────── */

const SYSTEM_CSS = `
.sc { display: flex; flex-direction: column; gap: 12px; padding: 18px; }
.sc .hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sc .brand { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-weight: 600; color: var(--k-t2); }
.srcs { display: flex; flex-direction: column; gap: 6px; }
.srow { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-radius: 12px; }
.srow.on { background: var(--k-s2); }
.sic { flex: none; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; }
.sm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sm .sn { font-weight: 600; }
.sm .sme { font-size: 12px; color: var(--k-t3); }
.srow .chip { height: 24px; padding: 0 9px; }
.loops { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.loop { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--k-bd); }
.loop .ln { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--k-t3); min-width: 0; }
.loop .ls { font-weight: 600; }
.loop .lsub { font-size: 12px; color: var(--k-t3); }
.dotc { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.energy { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 12px; border-radius: 12px; font-size: 12px; }
.energy .eg { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.trg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.trg .tl { font-size: 12px; color: var(--k-t3); }
.tchip { display: inline-flex; align-items: center; max-width: 100%; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 44px; padding: 0 12px;
  border-radius: 12px; border: 1px solid var(--k-bd2); background: transparent; font-weight: 600; text-align: left; cursor: pointer; }
@media (hover: hover) { .nav:hover { background: var(--k-s2); } }
@container (max-width: 300px) { .loops { grid-template-columns: minmax(0, 1fr); } }
`;

class KlimoSystemCard extends KlimoBase {
  static get css() {
    return SYSTEM_CSS;
  }

  static getConfigElement() {
    return document.createElement('klimo-system-card-editor');
  }

  static getStubConfig() {
    return { show: ['sources', 'circuits', 'energy', 'triggers'], sources: 'all' };
  }

  _normalize(config) {
    const c = commonOptions(config);
    c.show = listOf(config, 'show', ['sources', 'circuits', 'energy', 'triggers'], ['sources', 'circuits', 'energy', 'triggers']);
    if (config.sources !== undefined && config.sources !== 'all' && config.sources !== 'active' && !Array.isArray(config.sources)) {
      throw new Error('sources must be «all», «active» or a list of source ids');
    }
    c.sources = config.sources === undefined ? 'all' : config.sources;
    c.tap_action = config.tap_action || { action: 'klimo-open', route: '#/system' };
    return c;
  }

  _shell() {
    this._card.addEventListener('click', (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.some((n) => n && n.dataset && n.dataset.act === 'nav')) return;
      const ctx = this._ctx();
      runAction(this, this._config.tap_action, { hass: ctx.hass, hub: ctx.hubAttrs, route: '#/system', entity: ctx.hub && ctx.hub.id });
    });
  }

  _render(ctx) {
    const h = ctx.hubAttrs;
    if (!h) {
      this._message(this._missingHub(ctx));
      return;
    }
    const lang = ctx.lang;
    const c = this._config;
    const stale = this._isOffline(ctx, null);
    this._card.classList.toggle('stale', stale);
    const title = c.title === undefined ? tr(lang, 'system') : c.title;
    this._skeleton(
      '<div class="sc"><div data-s="banner" hidden></div><div class="body sc" style="padding:0">' +
        '<div class="hd" data-s="hd"></div><div data-s="sources" hidden></div><div data-s="circuits" hidden></div><div data-s="energy" hidden></div><div data-s="triggers" hidden></div>' +
        `<button type="button" class="nav" data-act="nav"><span class="ell">${esc(tr(lang, 'schema'))}</span>${ic('chevronRight', 18)}</button></div></div>`,
    );
    this._section('banner', stale ? this._offlineBanner(ctx, this._staleSince(ctx, null)) : '');
    this._section('hd', `<span class="brand">${ic('heatPump', 20)}<span class="ell">${esc(title)}</span></span>${seasonChip(h.season, lang)}`);
    this._section('sources', c.show.includes('sources') ? this._sources(ctx, h) : '');
    this._section('circuits', c.show.includes('circuits') ? this._circuits(ctx, h) : '');
    this._section('energy', c.show.includes('energy') ? this._energy(ctx, h) : '');
    this._section('triggers', c.show.includes('triggers') ? this._triggers(ctx, h) : '');
  }

  _sources(ctx, h) {
    const c = this._config;
    let list = Array.isArray(h.sources) ? h.sources : [];
    if (c.sources === 'active') list = list.filter((s) => s.on);
    else if (Array.isArray(c.sources)) list = c.sources.map((id) => list.find((s) => s.id === id)).filter(Boolean);
    if (!list.length) return '';
    const rows = list
      .map((s) => {
        const tone = baseTone(s.tone);
        const box = s.on ? toneVars(tone) : 'background:var(--k-s3);color:var(--k-t3)';
        // Klimo's own line under the name (telemetry, the fault, why it waits); an older add-on without it
        // gets the role and the start time
        let meta = fill(s.sub, s.at, ctx.lang, ctx.tz);
        if (!meta) {
          const role = s.role && s.role !== 'unused' ? tr(ctx.lang, `role_${s.role}`) : '';
          const since = s.on && isNum(s.at) ? tr(ctx.lang, 'since', { t: fmtClock(s.at, ctx.lang, ctx.tz) }) : '';
          meta = [role, since].filter(Boolean).join(' · ');
        }
        return (
          `<div class="srow${s.on ? ' on' : ''}"><span class="sic" style="${box}">${ic(s.i || 'anyEntity', 16)}</span>` +
          `<span class="sm"><span class="sn ell">${esc(s.n)}</span>${meta ? `<span class="sme ell">${esc(meta)}</span>` : ''}</span>` +
          `<span class="chip" style="${toneVars(tone)}">${esc(fill(s.t, s.at, ctx.lang, ctx.tz))}</span></div>`
        );
      })
      .join('');
    return `<div class="srcs">${rows}</div>`;
  }

  _circuits(ctx, h) {
    const list = Array.isArray(h.circuits) ? h.circuits : [];
    if (!list.length) return '';
    const tiles = list
      .map((cir) => {
        const dot = cir.on ? toneDot(cir.tone) : 'var(--k-idle)';
        const sub = fill(cir.sub, cir.at, ctx.lang, ctx.tz);
        return `<div class="loop"><span class="ln"><span class="dotc" style="background:${dot}"></span><span class="ell">${esc(cir.n)}</span></span><span class="ls ell">${esc(fill(cir.t, cir.at, ctx.lang, ctx.tz))}</span>${sub ? `<span class="lsub ell">${esc(sub)}</span>` : ''}</div>`;
      })
      .join('');
    return `<div class="loops">${tiles}</div>`;
  }

  _energy(ctx, h) {
    const e = h.energy;
    if (!e) return '';
    const lang = ctx.lang;
    const alarm = baseTone(e.tone) === 'err';
    const style = alarm ? toneVars('err') : 'background:var(--k-s2);color:var(--k-t2)';
    const items = [];
    if (isNum(e.pv)) items.push(tr(lang, 'sun', { v: fmtPower(e.pv, lang) }));
    if (isNum(e.bat)) items.push(tr(lang, 'battery', { v: Math.round(e.bat) }));
    if (isNum(e.load)) items.push(tr(lang, 'load', { v: fmtPower(e.load, lang) }));
    return `<div class="energy" style="${style}"><span class="eg" style="color:${alarm ? 'var(--k-err-fg)' : 'var(--k-t1)'}">${ic(e.g === 'absent' ? 'battery_storage' : 'bolt', 14)}${esc(fill(e.t, null, lang, ctx.tz))}</span>${items.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`;
  }

  _triggers(ctx, h) {
    const list = Array.isArray(h.triggers) ? h.triggers : [];
    if (!list.length) return '';
    const chips = list
      .slice()
      .sort((a, b) => Number(b.on) - Number(a.on))
      .map((t) => `<span class="tchip" style="${t.on ? toneVars('warn') : 'background:var(--k-s2);color:var(--k-t2)'}">${esc(fill(t.t || t.n, t.at, ctx.lang, ctx.tz))}</span>`)
      .join('');
    return `<div class="trg"><span class="tl">${esc(tr(ctx.lang, 'triggers'))}</span>${chips}</div>`;
  }

  getCardSize() {
    return 12;
  }
}

/* ─────────────────────────────── 11 Sheets: room sheet ─────────────────────────────────────── */

const SHEET_CSS = `
:host { position: fixed; inset: 0; z-index: 1000; display: block; }
.scrim { position: absolute; inset: 0; background: var(--k-scrim); animation: kfade .18s ease-out; }
.sheet { position: absolute; left: 50%; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%);
  width: min(430px, calc(100vw - 20px)); max-height: calc(100vh - 20px - env(safe-area-inset-bottom, 0px)); overflow: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 24px;
  background: var(--k-s1); color: var(--k-t1); border: 1px solid var(--k-bd); box-shadow: var(--k-shadow);
  font-family: var(--ha-font-family-body, 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif);
  font-size: 14px; line-height: 1.4; font-variant-numeric: tabular-nums; animation: kup .2s ease-out; container-type: inline-size; }
@media (min-width: 700px) {
  .sheet { top: 50%; bottom: auto; transform: translate(-50%, -50%); width: min(480px, calc(100vw - 40px)); max-height: calc(100vh - 40px); border-radius: 18px; animation: kpop .18s ease-out; }
}
@keyframes kfade { from { opacity: 0; } to { opacity: 1; } }
@keyframes kup { from { transform: translate(-50%, 24px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
@keyframes kpop { from { transform: translate(-50%, -48%); opacity: 0; } to { transform: translate(-50%, -50%); opacity: 1; } }
:host(.closing) .scrim, :host(.closing) .sheet { opacity: 0; transition: opacity .15s; }
.sh-hd { display: flex; align-items: center; gap: 10px; }
.sh-title { flex: 1; min-width: 0; font-size: 19px; font-weight: 600; }
.x { flex: none; width: 40px; height: 40px; padding: 0; border-radius: 12px; border: 1px solid var(--k-bd); background: var(--k-s2);
  display: flex; align-items: center; justify-content: center; cursor: pointer; }
.sh-sec { font-size: 12px; font-weight: 600; color: var(--k-t3); text-transform: none; margin-bottom: -6px; }
.pgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.pr { position: relative; display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 10px; border-radius: 12px; text-align: left;
  border: 1px solid var(--k-bd); background: transparent; cursor: pointer; min-width: 0; }
.pr[aria-checked='true'] { background: var(--k-s3); border-color: var(--k-t1); box-shadow: inset 0 0 0 1px var(--k-t1); }
.pr .pic { width: 32px; height: 32px; border-radius: 9px; flex: none; display: flex; align-items: center; justify-content: center; }
.pr .pm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pr .pn { font-weight: 600; }
.pr .pt { font-size: 12px; color: var(--k-t3); }
.pr .pnow { position: absolute; top: 6px; right: 8px; font-size: 11px; font-weight: 600; color: var(--k-t3); }
.durs { display: flex; flex-wrap: wrap; gap: 8px; }
.dch { height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--k-bd2); background: transparent; font-size: 13px; font-weight: 500; cursor: pointer; }
.dch[aria-checked='true'] { background: var(--k-abg); color: var(--k-afg); border-color: transparent; }
.cq { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: var(--k-s2); min-height: 48px; }
.cq .cm { display: flex; align-items: flex-start; gap: 8px; font-weight: 500; }
.cq .cm svg { margin-top: 1px; }
.cq .cchips { display: flex; flex-wrap: wrap; gap: 6px; }
.cq .cc { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 500;
  background: var(--k-s1); color: var(--k-t2); }
.cq .muted { color: var(--k-t3); font-size: 13px; }
.sh-ft { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.sh-ft .btn { min-height: 44px; border-radius: 12px; }
@media (hover: hover) { .pr:hover, .dch:hover { background: var(--k-s2); } .pr[aria-checked='true']:hover { background: var(--k-s3); }
  .dch[aria-checked='true']:hover { background: var(--k-abg); } .x:hover { background: var(--k-s3); } }
@container (max-width: 320px) { .pgrid { grid-template-columns: minmax(0, 1fr); } }
`;

/** Dialog plumbing shared by the two sheets: scrim, Escape, focus, closing animation. */
class KlimoSheet extends KlimoBase {
  static get shell() {
    return '<div class="scrim" data-act="close"></div><div class="sheet" data-root role="dialog" aria-modal="true"></div>';
  }

  connectedCallback() {
    super.connectedCallback();
    OpenSheets.add(this);
    this._restore = document.activeElement;
    this._onKeyDoc = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKeyDoc, true);
    if (!this._wired) {
      this._wired = true;
      this.shadowRoot.addEventListener('click', (e) => {
        const path = e.composedPath ? e.composedPath() : [];
        const el = path.find((n) => n && n.dataset && n.dataset.act);
        if (el) this._act(el.dataset.act, el);
      });
    }
    requestAnimationFrame(() => {
      const x = this.shadowRoot.querySelector('.x');
      if (x) x.focus();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    OpenSheets.delete(this);
    document.removeEventListener('keydown', this._onKeyDoc, true);
  }

  close() {
    if (this._closing) return;
    this._closing = true;
    this.classList.add('closing');
    setTimeout(() => {
      this.remove();
      const back = this._restore;
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    }, 150);
  }

  _act(act) {
    if (act === 'close') this.close();
  }

  _head(title, extra = '') {
    return `<div class="sh-hd"><span class="sh-title ell" id="ttl">${esc(title)}</span>${extra}<button type="button" class="x" data-act="close" aria-label="${esc(tr(this._c ? this._c.lang : 'en', 'close'))}">${ic('close', 18)}</button></div>`;
  }
}


const ROOM_SHEET_CSS = `${SHEET_CSS}
.sheet { gap: 12px; }
.sh-th { margin: 0 -2px; }
.iss { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 12px; font-size: 13px; font-weight: 500; }
.iss svg { margin-top: 1px; }
.iss .more { margin-left: auto; flex: none; opacity: .8; font-weight: 400; }
.iss-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: -4px; }
.why { font-size: 13px; color: var(--k-t2); }
.rows { display: flex; flex-direction: column; border-radius: 12px; background: var(--k-s2); padding: 2px 12px; }
.er { display: flex; align-items: center; gap: 10px; min-height: 40px; font-size: 13px; color: var(--k-t2); }
.er + .er { border-top: 1px solid var(--k-div); }
.er .en { flex: 1; min-width: 0; }
.er .ev { flex: none; color: var(--k-t1); font-weight: 500; }
.nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 44px; padding: 0 12px;
  border-radius: 12px; border: 1px solid var(--k-bd2); background: transparent; font-weight: 600; text-align: left; cursor: pointer; }
.snote { font-size: 13px; font-weight: 500; }
@media (hover: hover) { .nav:hover { background: var(--k-s2); } }
`;

/** Klimo's own entities of a room, shown in the sheet with their live values. */
const ROOM_ENTITIES = [
  ['sensor', 'temperature', 'thermometer'],
  ['sensor', 'humidity', 'droplet'],
  ['sensor', 'dew_point', 'droplet'],
  ['sensor', 'target', 'target'],
  ['binary_sensor', 'window', 'windowClosed'],
  ['binary_sensor', 'heat_demand', 'flame'],
  ['binary_sensor', 'cool_demand', 'snow'],
];

function entityValue(st, kind, lang) {
  if (!st || st.state === 'unavailable' || st.state === 'unknown') return tr(lang, 'unavailable');
  if (kind === 'window') return tr(lang, st.state === 'on' ? 'on_window' : 'off_window');
  if (kind === 'heat_demand' || kind === 'cool_demand') return tr(lang, st.state === 'on' ? 'on_demand' : 'off_demand');
  const n = Number(st.state);
  if (!Number.isFinite(n)) return st.state;
  const unit = st.attributes && st.attributes.unit_of_measurement;
  if (unit === '%') return `${Math.round(n)}%`;
  return fmtTemp(n);
}

class KlimoRoomSheet extends KlimoSheet {
  static get css() {
    return ROOM_SHEET_CSS;
  }

  _normalize(config) {
    const c = commonOptions(config);
    c.room = config.room;
    return c;
  }

  _deps(ctx) {
    this._ref = resolveRoom(ctx.hass, this._config.room, ctx.hubAttrs);
    const r = this._ref;
    const slug = r && r.slug;
    const extra = slug ? ROOM_ENTITIES.map(([d, k]) => ctx.hass.states[`${d}.klimo_${slug}_${k}`]) : [];
    return [ctx.hub && ctx.hub.st, r && r.card && r.card.st, ...extra];
  }

  _render(ctx) {
    this._c = ctx;
    const lang = ctx.lang;
    const r = this._ref;
    const a = r && r.card && r.card.attrs;
    if (!this._parts) {
      this._card.innerHTML = '<div class="sh-head"></div><div class="sh-th"></div><div class="sh-rest"></div>';
      this._parts = {
        head: this._card.querySelector('.sh-head'),
        th: this._card.querySelector('.sh-th'),
        rest: this._card.querySelector('.sh-rest'),
      };
      this._card.setAttribute('aria-labelledby', 'ttl');
    }
    const sk = this._parts;
    if (!a && !(r && r.row)) {
      setHtml(sk.head, this._head(tr(lang, 'rooms')));
      setHtml(sk.rest, ctx.hub ? `<div class="msg">${esc(tr(lang, 'roomNotFound', { room: this._config.room }))}</div>` : this._missingHub(ctx));
      return;
    }
    const v = roomView(ctx, a ? r.card : null, r.row);
    setHtml(sk.head, this._head(v.name, stateChip(v.state)));
    if (!this._thermo) {
      this._thermo = document.createElement('klimo-thermostat-card');
      this._thermo.setConfig({ room: v.slug || this._config.room, theme: this._config.theme, language: this._config.language, hub_entity: this._config.hub_entity, _embedded: true });
      sk.th.appendChild(this._thermo);
    }
    this._thermo.hass = ctx.hass;

    const parts = [];
    if (this._note && this._note.until > Date.now()) parts.push(`<div class="snote" style="color:${this._note.color}">${esc(this._note.text)}</div>`);
    if (v.iss) {
      const more = v.iss.more ? `<span class="more">${esc(tr(lang, 'moreIssues', { n: v.iss.more }))}</span>` : '';
      parts.push(`<div class="iss" style="${toneVars(v.iss.tone)}">${ic(v.iss.icon, 16)}<span>${esc(v.iss.text)}</span>${more}</div>`);
      if (v.iss.id) {
        parts.push(
          `<div class="iss-acts"><button type="button" class="btn" data-act="snooze">${esc(tr(lang, 'ignore30'))}</button><button type="button" class="btn" data-act="dismiss">${esc(tr(lang, 'hide'))}</button></div>`,
        );
      }
    }
    if (v.why) parts.push(`<div class="sh-sec">${esc(tr(lang, 'why'))}</div><div class="why">${esc(v.why)}</div>`);
    const rows = [];
    if (v.slug) {
      for (const [domain, kind, icon] of ROOM_ENTITIES) {
        const st = ctx.hass.states[`${domain}.klimo_${v.slug}_${kind}`];
        if (!st) continue;
        rows.push(`<div class="er">${ic(kind === 'window' && st.state === 'on' ? 'windowOpen' : icon, 16)}<span class="en ell">${esc(tr(lang, `e_${kind}`))}</span><span class="ev">${esc(entityValue(st, kind, lang))}</span></div>`);
      }
    }
    if (!rows.length && v.attrs) {
      // no entities to read (renamed ids): the card sensor still knows the essentials
      rows.push(`<div class="er">${ic('thermometer', 16)}<span class="en">${esc(tr(lang, 'e_temperature'))}</span><span class="ev">${esc(fmtTemp(v.t))}</span></div>`);
      if (isNum(v.h)) rows.push(`<div class="er">${ic('droplet', 16)}<span class="en">${esc(tr(lang, 'e_humidity'))}</span><span class="ev">${Math.round(v.h)}%</span></div>`);
      if (v.win) rows.push(`<div class="er">${ic(v.win.o ? 'windowOpen' : 'windowClosed', 16)}<span class="en">${esc(tr(lang, 'e_window'))}</span><span class="ev">${esc(fill(v.win.t, v.win.at, lang, ctx.tz))}</span></div>`);
    }
    if (rows.length) parts.push(`<div class="sh-sec">${esc(tr(lang, 'sensors'))}</div><div class="rows">${rows.join('')}</div>`);
    parts.push(`<button type="button" class="nav" data-act="open"><span class="ell">${esc(tr(lang, 'openKlimo'))}</span>${ic('external', 18)}</button>`);
    setHtml(sk.rest, `<div style="display:flex;flex-direction:column;gap:12px">${parts.join('')}</div>`);
  }

  _act(act) {
    const ctx = this._c;
    const r = this._ref;
    const a = r && r.card && r.card.attrs;
    if (act === 'open') {
      openKlimo(ctx && ctx.hubAttrs, r && r.id ? `#/rooms/${r.id}` : '#/rooms');
      this.close();
      return;
    }
    if ((act === 'snooze' || act === 'dismiss') && a && a.iss) {
      const incidentId = a.iss.id || a.iss.incidentId;
      if (!incidentId) return;
      const cmd = act === 'snooze' ? { action: 'incident.snooze', incidentId, minutes: 30 } : { action: 'incident.dismiss', incidentId };
      command(this._hass, cmd).then(({ error }) => {
        if (!error) return;
        this._note = { text: tr(ctx.lang, 'failed', { e: error }), color: 'var(--k-err-fg)', until: Date.now() + 5000 };
        this._update(true);
      });
      return;
    }
    super._act(act);
  }
}

/* ─────────────────────────────── 12 Profile sheet ──────────────────────────────────────────── */

class KlimoProfileSheet extends KlimoSheet {
  static get css() {
    return `${SHEET_CSS}`;
  }

  _normalize(config) {
    const c = commonOptions(config);
    c.durations = Array.isArray(config.durations) && config.durations.length ? config.durations : ['slot', '2h', 'morning', 'none'];
    return c;
  }

  _render(ctx) {
    this._c = ctx;
    const h = ctx.hubAttrs;
    const lang = ctx.lang;
    if (!h) {
      this._message(`${this._head(tr(lang, 'profileSheet'))}${this._missingHub(ctx)}`);
      return;
    }
    const hp = (h.house && h.house.profile) || {};
    if (this._pick === undefined) {
      this._pick = hp.id || null;
      this._dur = this._config.durations[0];
    }
    const profiles = Array.isArray(h.profiles) ? h.profiles : [];
    const season = h.season ? h.season.cur : 'heating';
    const temps = (p) => {
      if (p.frost) return tr(lang, 'frostOnly');
      if (season === 'cooling') return fmtTemp(p.cl);
      if (season === 'neutral' && isNum(p.h) && isNum(p.cl)) return fmtRange(p.h, p.cl);
      return fmtTemp(p.h);
    };
    const grid = profiles
      .map((p, i) => {
        const pal = TOKENS.profiles[i % TOKENS.profiles.length];
        const now = p.id === hp.id ? `<span class="pnow">${esc(tr(lang, 'profileNow'))}</span>` : '';
        return (
          `<button type="button" class="pr" role="radio" aria-checked="false" data-act="profile" data-id="${esc(p.id)}">` +
          `<span class="pic" style="background:${safeColor(p.c, pal.color)};color:${safeColor(p.k, pal.ink)}">${ic(p.i || 'home', 18)}</span>` +
          `<span class="pm"><span class="pn ell">${esc(p.n)}</span><span class="pt ell">${esc(temps(p))}</span></span>${now}</button>`
        );
      })
      .join('');
    const available = Array.isArray(h.durations) && h.durations.length ? h.durations : null;
    const durs = this._config.durations
      .filter((d) => d !== 'until' && (!available || available.some((x) => x.id === d)))
      .map((d) => {
        const u = available ? (available.find((x) => x.id === d) || {}).u : null;
        let label = tr(lang, `dur_${d}`);
        if (d === 'slot') label = isNum(u) ? tr(lang, 'dur_slot', { t: fmtClock(u, lang, ctx.tz) }) : tr(lang, 'dur_slotOpen');
        return `<button type="button" class="dch" role="radio" aria-checked="false" data-act="dur" data-id="${d}">${esc(label)}</button>`;
      })
      .join('');
    const can = this._canApply(hp);
    this._skeleton(
      `<div class="psk" style="display:contents">${this._head(tr(lang, 'profileSheet'))}` +
        '<div class="pgrid" role="radiogroup" aria-labelledby="ttl" data-s="grid"></div>' +
        `<div class="sh-sec">${esc(tr(lang, 'duration'))}</div><div class="durs" role="radiogroup" data-s="durs"></div>` +
        `<div class="sh-sec">${esc(tr(lang, 'consequences'))}</div><div class="cq" role="status" data-s="cq"></div>` +
        `<div class="sh-ft"><button type="button" class="btn" data-act="close">${esc(tr(lang, 'cancel'))}</button>` +
        `<button type="button" class="btn primary" data-act="apply">${esc(tr(lang, 'apply'))}</button></div></div>`,
    );
    this._section('grid', grid);
    this._section('durs', durs);
    // selection is patched in place, so the focused choice keeps its focus
    for (const b of this._sk.grid.querySelectorAll('[data-id]')) b.setAttribute('aria-checked', String(b.dataset.id === this._pick));
    for (const b of this._sk.durs.querySelectorAll('[data-id]')) b.setAttribute('aria-checked', String(b.dataset.id === this._dur));
    this._section('cq', this._consequences(ctx, hp));
    this._sk.root.querySelector('[data-act="apply"]').disabled = !can;
    this._card.setAttribute('aria-labelledby', 'ttl');
    if (can && !this._preview && !this._asking) this._ask();
  }

  _canApply(hp) {
    if (!this._pick) return false;
    return !(this._pick === hp.id && this._dur === 'slot' && hp.layer !== 'house_manual');
  }

  _consequences(ctx, hp) {
    const lang = ctx.lang;
    if (!this._canApply(hp)) return `<span class="muted">${esc(tr(lang, 'pickProfile'))}</span>`;
    const p = this._preview;
    if (!p || p.key !== this._key()) return `<span class="muted">${esc(tr(lang, this._timedOut ? 'noPreview' : 'counting'))}</span>`;
    const d = p.data;
    const at = isNum(d.until) ? d.until : null;
    const tone = baseTone(d.tone);
    const color = tone === 'hold' || tone === 'off' ? 'var(--k-t1)' : `var(--k-${tone}-fg)`;
    const chips = Array.isArray(d.chips) && d.chips.length ? `<div class="cchips">${d.chips.map((c) => `<span class="cc">${esc(fill(c, at, lang, ctx.tz))}</span>`).join('')}</div>` : '';
    return `<div class="cm" style="color:${color}">${ic(d.icon || 'info', 16)}<span>${esc(fill(d.main, at, lang, ctx.tz))}</span></div>${chips}`;
  }

  _key() {
    return `${this._pick}|${this._dur}`;
  }

  /** house.preview_profile for the current pick; only the latest answer is shown. */
  _ask() {
    const key = this._key();
    this._asking = key;
    this._timedOut = false;
    clearTimeout(this._askTimer);
    this._askTimer = setTimeout(() => {
      command(this._hass, { action: 'house.preview_profile', profileId: this._pick, duration: this._dur }).then(({ reply }) => {
        if (this._asking !== key) return;
        this._asking = null;
        if (reply && reply.ok && reply.preview) this._preview = { key, data: reply.preview };
        else this._timedOut = true;
        this._update(true);
      });
    }, 250);
  }

  _act(act, el) {
    if (act === 'profile' || act === 'dur') {
      if (act === 'profile') this._pick = el.dataset.id;
      else this._dur = el.dataset.id;
      this._preview = null;
      this._asking = null;
      this._timedOut = false;
      this._update(true);
      return;
    }
    if (act === 'apply') {
      const h = this._c && this._c.hubAttrs;
      const hp = (h && h.house && h.house.profile) || {};
      if (!this._canApply(hp)) return;
      const lang = this._c.lang;
      const profile = ((h && h.profiles) || []).find((p) => p.id === this._pick);
      const available = (h && Array.isArray(h.durations) && h.durations) || [];
      const u = (available.find((x) => x.id === this._dur) || {}).u;
      const until = isNum(u) ? tr(lang, 'until', { t: fmtClock(u, lang, this._c.tz) }) : this._dur === 'none' ? '' : tr(lang, `dur_${this._dur}`).toLowerCase();
      const { done } = sendCommand(this._hass, { action: 'house.set_profile', profileId: this._pick, duration: this._dur });
      if (this.onApply) this.onApply({ done, text: tr(lang, 'profileApplied', { p: profile ? profile.n : this._pick, u: until }).trim() });
      this.close();
      return;
    }
    super._act(act);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._askTimer);
  }
}

/* ─────────────────────────────── 13 Editors ────────────────────────────────────────────────── */

const EDITOR_CSS = `
:host { display: block; }
.f { display: flex; flex-direction: column; gap: 14px; padding: 8px 0; font-family: var(--ha-font-family-body, system-ui, sans-serif); color: var(--primary-text-color); }
.fld { display: flex; flex-direction: column; gap: 6px; }
.lbl { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); }
select, input[type='text'] { min-height: 40px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
  background: var(--card-background-color, transparent); color: var(--primary-text-color); font: inherit; }
.checks { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.checks label, .tog { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }
input[type='checkbox'] { width: 18px; height: 18px; margin: 0; accent-color: var(--primary-color); }
`;

/**
 * A small form editor: native inputs in a shadow root, `config-changed` on every edit. It is
 * rebuilt only on setConfig and when the room list first arrives, never on plain hass updates,
 * so typing is not interrupted.
 */
class KlimoEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const before = this._roomsSig;
    this._hass = hass;
    const sig = this._rooms().map((r) => r.s).join('|');
    if (sig !== before) this._render();
  }

  _lang() {
    const c = this._config;
    if (c.language === 'uk' || c.language === 'en') return c.language;
    const hub = this._hass ? readHub(this._hass, c) : null;
    if (hub && hub.attrs && (hub.attrs.lang === 'uk' || hub.attrs.lang === 'en')) return hub.attrs.lang;
    const ha = String((this._hass && ((this._hass.locale && this._hass.locale.language) || this._hass.language)) || 'en');
    return ha.startsWith('uk') ? 'uk' : 'en';
  }

  _rooms() {
    if (!this._hass) return [];
    const hub = readHub(this._hass, this._config);
    return hubRooms(hub && hub.attrs);
  }

  /** [{key, type, label, options?}] — the fields of this card. */
  _fields() {
    return [];
  }

  _common(lang) {
    return [
      { key: 'title', type: 'text', label: tr(lang, 'ed_title') },
      { key: 'theme', type: 'select', label: tr(lang, 'ed_theme'), def: 'auto', options: [['auto', tr(lang, 'ed_auto')], ['dark', tr(lang, 'ed_dark')], ['light', tr(lang, 'ed_light')]] },
      { key: 'language', type: 'select', label: tr(lang, 'ed_language'), def: 'auto', options: [['auto', tr(lang, 'ed_auto')], ['uk', 'Українська'], ['en', 'English']] },
    ];
  }

  _render() {
    const lang = this._lang();
    const rooms = this._rooms();
    this._roomsSig = rooms.map((r) => r.s).join('|');
    const c = this._config;
    const html = this._fields(lang, rooms)
      .map((f, i) => {
        const id = `f${i}`;
        if (f.type === 'bool') {
          const on = c[f.key] === undefined ? f.def !== false : c[f.key] !== false;
          return `<label class="tog"><input type="checkbox" data-k="${f.key}" data-t="bool"${on ? ' checked' : ''}>${esc(f.label)}</label>`;
        }
        if (f.type === 'multi') {
          const cur = Array.isArray(c[f.key]) ? c[f.key] : c[f.key] === 'all' && f.all ? f.options.map((o) => o[0]) : f.def;
          const boxes = f.options
            .map(([v, label]) => `<label><input type="checkbox" data-k="${f.key}" data-t="multi" value="${esc(v)}"${cur.includes(v) ? ' checked' : ''}>${esc(label)}</label>`)
            .join('');
          return `<div class="fld"><span class="lbl">${esc(f.label)}</span><div class="checks">${boxes}</div></div>`;
        }
        if (f.type === 'text') {
          return `<div class="fld"><label class="lbl" for="${id}">${esc(f.label)}</label><input id="${id}" type="text" data-k="${f.key}" data-t="text" value="${esc(c[f.key] ?? '')}"></div>`;
        }
        const cur = c[f.key] === undefined || c[f.key] === null ? f.def : String(c[f.key]);
        const opts = [...f.options];
        if (cur && !opts.some((o) => o[0] === cur)) opts.push([cur, cur]);
        const options = opts.map(([v, label]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`).join('');
        return `<div class="fld"><label class="lbl" for="${id}">${esc(f.label)}</label><select id="${id}" data-k="${f.key}" data-t="select">${options}</select></div>`;
      })
      .join('');
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}</style><div class="f">${html}</div>`;
    this.shadowRoot.querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener(el.dataset.t === 'text' ? 'input' : 'change', () => this._changed(el));
    });
  }

  _changed(el) {
    const key = el.dataset.k;
    const field = this._fields(this._lang(), this._rooms()).find((f) => f.key === key);
    let value;
    if (el.dataset.t === 'bool') value = el.checked;
    else if (el.dataset.t === 'multi') {
      value = [...this.shadowRoot.querySelectorAll(`input[data-k="${key}"]:checked`)].map((x) => x.value);
      if (field && field.all && value.length === field.options.length) value = 'all';
    } else value = el.value;
    if (field && field.map) value = field.map(value);
    const next = { ...this._config };
    if (value === '' || value === undefined || value === null || (field && field.def !== undefined && value === field.def && field.type === 'select')) delete next[key];
    else next[key] = value;
    this._config = next;
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: next }, bubbles: true, composed: true }));
  }
}

const roomOptions = (rooms) => rooms.map((r) => [r.s, r.n]);

class KlimoRoomCardEditor extends KlimoEditor {
  _fields(lang, rooms) {
    return [
      { key: 'room', type: 'select', label: tr(lang, 'ed_room'), def: '', options: [['', '—'], ...roomOptions(rooms)] },
      { key: 'variant', type: 'select', label: tr(lang, 'ed_variant'), def: 'card', options: [['card', tr(lang, 'ed_card')], ['compact', tr(lang, 'ed_compact')]] },
      { key: 'show_sparkline', type: 'bool', label: tr(lang, 'ed_sparkline'), def: true },
      { key: 'show_issue', type: 'bool', label: tr(lang, 'ed_issue'), def: true },
      {
        key: 'show_meta',
        type: 'multi',
        label: tr(lang, 'ed_meta'),
        def: ['humidity', 'window', 'device'],
        options: [['humidity', tr(lang, 'k_humidity')], ['window', tr(lang, 'k_window')], ['device', tr(lang, 'k_device')]],
      },
      ...this._common(lang).slice(1),
    ];
  }
}

class KlimoRoomsCardEditor extends KlimoEditor {
  _fields(lang, rooms) {
    return [
      { key: 'rooms', type: 'multi', all: true, label: tr(lang, 'ed_rooms'), def: rooms.map((r) => r.s), options: roomOptions(rooms) },
      { key: 'variant', type: 'select', label: tr(lang, 'ed_variant'), def: 'compact', options: [['compact', tr(lang, 'ed_compact')], ['card', tr(lang, 'ed_card')]] },
      {
        key: 'sort',
        type: 'select',
        label: tr(lang, 'ed_sort'),
        def: 'attention_first',
        options: [['attention_first', tr(lang, 'ed_attentionFirst')], ['config', tr(lang, 'ed_config')], ['name', tr(lang, 'ed_name')], ['temperature', tr(lang, 'ed_temperature')]],
      },
      ...this._common(lang),
    ];
  }
}

class KlimoThermostatCardEditor extends KlimoEditor {
  _fields(lang, rooms) {
    const durs = TARGET_DURATIONS.map((d) => [d, tr(lang, d === 'slot' ? 'dur_slotOpen' : `dur_${d}`)]);
    return [
      { key: 'room', type: 'select', label: tr(lang, 'ed_room'), def: '', options: [['', '—'], ...roomOptions(rooms)] },
      {
        key: 'controls',
        type: 'select',
        label: tr(lang, 'ed_controls'),
        def: 'direct',
        options: [['direct', tr(lang, 'ed_direct')], ['locked', tr(lang, 'ed_lockedOpt')], ['admin_only', tr(lang, 'ed_adminOnly')]],
      },
      { key: 'step', type: 'select', label: tr(lang, 'ed_step'), def: '', options: [['', tr(lang, 'ed_roomStep')], ['0.1', '0.1°'], ['0.5', '0.5°'], ['1', '1°']], map: (v) => (v === '' ? '' : Number(v)) },
      { key: 'durations', type: 'multi', label: tr(lang, 'ed_durations'), def: ['slot', '1h', '3h', 'forever'], options: durs },
      { key: 'default_duration', type: 'select', label: tr(lang, 'ed_defaultDuration'), def: 'slot', options: durs },
      { key: 'quick_actions', type: 'multi', label: tr(lang, 'ed_quick'), def: ['boost', 'airing'], options: [['boost', tr(lang, 'k_boost')], ['airing', tr(lang, 'k_airing')]] },
      { key: 'show_schedule', type: 'bool', label: tr(lang, 'ed_schedule'), def: true },
      { key: 'show_meta', type: 'bool', label: tr(lang, 'ed_metaRow'), def: true },
      ...this._common(lang).slice(1),
    ];
  }
}

class KlimoHouseCardEditor extends KlimoEditor {
  _fields(lang) {
    return [
      { key: 'show_profile', type: 'bool', label: tr(lang, 'ed_profile'), def: true },
      {
        key: 'profile_change',
        type: 'select',
        label: tr(lang, 'ed_profileChange'),
        def: 'confirm',
        options: [['confirm', tr(lang, 'ed_confirm')], ['navigate', tr(lang, 'ed_navigate')], ['none', tr(lang, 'ed_none')]],
      },
      { key: 'show_attention', type: 'bool', label: tr(lang, 'ed_attention'), def: true },
      {
        key: 'show_system',
        type: 'multi',
        label: tr(lang, 'ed_tiles'),
        def: ['source', 'pumps', 'outdoor'],
        options: [['source', tr(lang, 'k_source')], ['pumps', tr(lang, 'k_pumps')], ['humidity', tr(lang, 'k_humidity')], ['outdoor', tr(lang, 'k_outdoor')]],
      },
      ...this._common(lang),
    ];
  }
}

class KlimoSystemCardEditor extends KlimoEditor {
  _fields(lang) {
    return [
      {
        key: 'show',
        type: 'multi',
        label: tr(lang, 'ed_sections'),
        def: ['sources', 'circuits', 'energy', 'triggers'],
        options: [['sources', tr(lang, 'k_sources')], ['circuits', tr(lang, 'k_circuits')], ['energy', tr(lang, 'k_energy')], ['triggers', tr(lang, 'k_triggers')]],
      },
      { key: 'sources', type: 'select', label: tr(lang, 'ed_sources'), def: 'all', options: [['all', tr(lang, 'ed_all')], ['active', tr(lang, 'ed_active')]] },
      ...this._common(lang),
    ];
  }
}

/* ─────────────────────────────── registration ──────────────────────────────────────────────── */

if (!customElements.get('klimo-room-card')) customElements.define('klimo-room-card', KlimoRoomCard);
if (!customElements.get('klimo-rooms-card')) customElements.define('klimo-rooms-card', KlimoRoomsCard);
if (!customElements.get('klimo-thermostat-card')) customElements.define('klimo-thermostat-card', KlimoThermostatCard);
if (!customElements.get('klimo-house-card')) customElements.define('klimo-house-card', KlimoHouseCard);
if (!customElements.get('klimo-system-card')) customElements.define('klimo-system-card', KlimoSystemCard);
if (!customElements.get('klimo-room-sheet')) customElements.define('klimo-room-sheet', KlimoRoomSheet);
if (!customElements.get('klimo-profile-sheet')) customElements.define('klimo-profile-sheet', KlimoProfileSheet);
if (!customElements.get('klimo-room-card-editor')) customElements.define('klimo-room-card-editor', KlimoRoomCardEditor);
if (!customElements.get('klimo-rooms-card-editor')) customElements.define('klimo-rooms-card-editor', KlimoRoomsCardEditor);
if (!customElements.get('klimo-thermostat-card-editor')) customElements.define('klimo-thermostat-card-editor', KlimoThermostatCardEditor);
if (!customElements.get('klimo-house-card-editor')) customElements.define('klimo-house-card-editor', KlimoHouseCardEditor);
if (!customElements.get('klimo-system-card-editor')) customElements.define('klimo-system-card-editor', KlimoSystemCardEditor);

window.customCards = window.customCards || [];
for (const card of [
  { type: 'klimo-house-card', name: 'Klimo · House', description: 'Season, how many rooms heat or cool, the system at a glance, the house profile and what needs attention.' },
  { type: 'klimo-thermostat-card', name: 'Klimo · Thermostat', description: 'A room thermostat: −/+ or the knob, the consequence before sending, 3 s to cancel and 8 s to undo.' },
  { type: 'klimo-room-card', name: 'Klimo · Room', description: 'One room at a glance: state, temperature and trend, where the target comes from, a 6-hour chart.' },
  { type: 'klimo-rooms-card', name: 'Klimo · Rooms', description: 'All rooms as compact rows, the ones that need attention first.' },
  { type: 'klimo-system-card', name: 'Klimo · System', description: 'Climate sources with their roles, circuits and pumps, energy and active triggers.' },
]) {
  if (!window.customCards.some((c) => c.type === card.type)) {
    window.customCards.push({ ...card, preview: true, documentationURL: 'https://github.com/RobinCK/klimo/blob/main/klimo/DOCS.md' });
  }
}

console.info(`%c KLIMO-CARDS %c ${VERSION} `, 'background:#15181C;color:#FF8A3D;font-weight:600;border-radius:3px 0 0 3px', 'background:#4DA6FF;color:#04172A;border-radius:0 3px 3px 0');
