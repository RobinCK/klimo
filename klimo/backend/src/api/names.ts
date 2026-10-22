import type { EmitterKind, Lang, SourceKind } from '../shared/model';

/* =====================================================================================================
 * Default names for objects created without one. They are ordinary user data afterwards (the user
 * renames them), written in the notification language like the first-boot seed.
 * ===================================================================================================== */

const SOURCE_NAMES: Record<SourceKind, Record<Lang, string>> = {
  gas_boiler: { uk: 'Газовий котел', en: 'Gas boiler' },
  electric_boiler: { uk: 'Електрокотел', en: 'Electric boiler' },
  heat_pump: { uk: 'Тепловий насос', en: 'Heat pump' },
  ac: { uk: 'Кондиціонер', en: 'Air conditioner' },
  electric_radiator: { uk: 'Конвектор', en: 'Convector' },
  electric_floor: { uk: 'Електрична підлога', en: 'Electric floor' },
  ir_panel: { uk: 'ІЧ-панель', en: 'IR panel' },
  custom: { uk: 'Джерело', en: 'Source' },
};

const EMITTER_NAMES: Record<EmitterKind, Record<Lang, string>> = {
  radiator: { uk: 'Радіатори', en: 'Radiators' },
  floor: { uk: 'Тепла підлога', en: 'Floor heating' },
  fancoil: { uk: 'Фанкойл', en: 'Fan coil' },
  towel_rail: { uk: 'Рушникосушка', en: 'Towel rail' },
  direct: { uk: 'Прилад у кімнаті', en: 'Room device' },
};

const WORDS = {
  newProfile: { uk: 'Новий профіль', en: 'New profile' },
  copy: { uk: 'копія', en: 'copy' },
} as const;

export const sourceName = (kind: SourceKind, lang: Lang): string => SOURCE_NAMES[kind][lang];
export const emitterName = (kind: EmitterKind, lang: Lang): string => EMITTER_NAMES[kind][lang];
export const newProfileName = (lang: Lang): string => WORDS.newProfile[lang];

/** «Тепловий насос (копія)» — the name of a duplicate. */
export function copyName(name: string, lang: Lang, maxLen: number): string {
  const suffix = ` (${WORDS.copy[lang]})`;
  return name.slice(0, Math.max(1, maxLen - suffix.length)) + suffix;
}

/** `base`, else `base 2`, `base 3`… — the first that no existing name takes (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>, maxLen: number): string {
  const used = new Set([...taken].map((n) => n.trim().toLocaleLowerCase()));
  const fit = (s: string, tail = '') => s.slice(0, Math.max(1, maxLen - tail.length)) + tail;
  if (!used.has(fit(base).toLocaleLowerCase())) return fit(base);
  for (let n = 2; n < 1000; n++) {
    const candidate = fit(base, ` ${n}`);
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return fit(base);
}
