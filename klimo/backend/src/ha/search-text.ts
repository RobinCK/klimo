import { transliterate } from '../shared/translit';

/**
 * Text folding for the entity pickers. Both the query and every candidate field are brought to the
 * same lower-case Latin form — Ukrainian transliterated by KMU-2010, diacritics stripped — so
 * «vitalnia» finds «Вітальня» and «вітал» finds an entity in the area «Вітальня».
 */
export function fold(text: string): string {
  return transliterate(text).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Folded text with every run of non-alphanumerics collapsed to one space (word matching). */
export function searchKey(text: string | null | undefined): string {
  if (!text) return '';
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The text starts with the query, or one of its words does. */
export function wordPrefix(text: string, q: string): boolean {
  return !!q && (text.startsWith(q) || text.includes(` ${q}`));
}

export interface MatchFields {
  entityId: string;
  name: string;
  areaName: string | null;
  deviceName: string | null;
  /** Model, manufacturer, integration: found by a substring only. */
  extra?: (string | null)[];
}

export const SCORE = {
  exactId: 100,
  idPrefix: 80,
  namePrefix: 60,
  area: 50,
  device: 40,
  anywhere: 30,
  available: 10,
  nearRoom: 5,
} as const;

/**
 * How well a query names an entity: 100 exact entity id · 80 entity id prefix · 60 name prefix ·
 * 50 area name · 40 device name · 30 substring anywhere (or every word of a multi-word query found
 * somewhere); 0 = no match.
 */
export function matchScore(query: string, f: MatchFields): number {
  const q = searchKey(query);
  if (!q) return 0;
  const rawQ = query.trim().toLowerCase();
  const qId = q.replace(/ /g, '_');
  const id = f.entityId.toLowerCase();
  const objectId = id.slice(id.indexOf('.') + 1);

  if (id === rawQ || id === qId || objectId === qId) return SCORE.exactId;
  if (id.startsWith(rawQ) || id.startsWith(qId) || objectId.startsWith(qId)) return SCORE.idPrefix;

  const name = searchKey(f.name);
  if (wordPrefix(name, q)) return SCORE.namePrefix;
  const area = searchKey(f.areaName);
  if (area && (wordPrefix(area, q) || area.includes(q))) return SCORE.area;
  const device = searchKey(f.deviceName);
  if (device && (wordPrefix(device, q) || device.includes(q))) return SCORE.device;

  const haystack = [searchKey(f.entityId), name, area, device, ...(f.extra ?? []).map(searchKey)].filter(Boolean).join(' ');
  if (haystack.includes(q)) return SCORE.anywhere;
  // «спальня темп» → every word starts a word somewhere (substrings of single letters would match everything)
  const tokens = q.split(' ');
  if (tokens.length > 1 && tokens.every((t) => wordPrefix(haystack, t))) return SCORE.anywhere;
  return 0;
}

/** HA's own slug rule for generated service names (`notify.mobile_app_<slug of the device name>`). */
export function haSlug(text: string): string {
  return searchKey(text).replace(/ /g, '_');
}
