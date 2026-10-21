/**
 * Ukrainian → Latin transliteration by the official KMU-2010 table (Resolution No. 55), used for room
 * slugs (`Вітальня` → `vitalnia`, `climate.klimo_vitalnia`) and for searching Latin entity ids with
 * Cyrillic queries. Є Ї Й Ю Я take their "word-initial" form at the start of a word; «зг» becomes
 * «zgh» so it is not read as «ж»; the soft sign and apostrophes disappear.
 */
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia',
  // letters outside the Ukrainian alphabet that still show up in names
  ё: 'io', ы: 'y', э: 'e', ъ: '',
};

const WORD_INITIAL: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
const APOSTROPHES = new Set(["'", '’', 'ʼ', '`', '‘']);

function isLetter(ch: string | undefined): boolean {
  return !!ch && /[\p{L}]/u.test(ch);
}

export function transliterate(text: string): string {
  const src = text.normalize('NFC');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const lower = ch.toLowerCase();
    if (APOSTROPHES.has(ch)) continue;
    let latin: string | undefined;
    if (lower === 'г' && src[i - 1]?.toLowerCase() === 'з') latin = 'gh';
    else if (WORD_INITIAL[lower] && !isLetter(src[i - 1]) && !APOSTROPHES.has(src[i - 1] ?? '')) latin = WORD_INITIAL[lower];
    else latin = MAP[lower];
    if (latin === undefined) {
      out += ch;
      continue;
    }
    // keep the case of the source letter (Щука → Shchuka)
    out += ch !== lower && latin ? latin[0].toUpperCase() + latin.slice(1) : latin;
  }
  return out;
}

export const SLUG_MAX = 40;
export const SLUG_PATTERN = /^[a-z0-9_]{1,40}$/;

/** `[a-z0-9_]{1,40}` from any name; `fallback` when nothing usable remains. */
export function slugify(name: string, fallback = 'room'): string {
  const slug = transliterate(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/_+$/g, '');
  return slug || fallback;
}

/** `base`, or `base_2`, `base_3`… — the first that is not taken (the suffix never exceeds 40 chars). */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, SLUG_MAX - suffix.length).replace(/_+$/g, '') + suffix;
    if (!taken(candidate)) return candidate;
  }
}
