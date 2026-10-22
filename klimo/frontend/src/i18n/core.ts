// i18next setup. The KEY is the English source text, so a missing translation falls back to
// English and the UI never shows blanks. Dictionaries live in src/locales/<lang>.json and
// are kept in sync with the code by `npm run i18n` (see i18next-parser.config.js).
// The language is chosen once at boot; changing it reloads the page, so plain functions
// (not hooks) are enough everywhere.
import i18next, { type Resource } from 'i18next';
import type { Lang } from '@api/model';
import en from '../locales/en.json';

export const LANGS: readonly Lang[] = ['uk', 'en'];

/** Self-labelled names for the language picker. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { uk: 'Українська', en: 'English' };

export type TVars = Record<string, string | number | null | undefined>;

let current: Lang = 'en';
let ready = false;

export function isLang(v: unknown): v is Lang {
  return v === 'uk' || v === 'en';
}

/** Initialise once, before the first render. */
export async function initI18n(lang: Lang): Promise<void> {
  current = lang;
  // the Ukrainian dictionary is a separate chunk, fetched only when it is the chosen language
  const resources: Resource = { en: { translation: en } };
  if (lang === 'uk') resources.uk = { translation: (await import('../locales/uk.json')).default };
  await i18next.init({
    lng: lang,
    fallbackLng: 'en',
    resources,
    // keys are English sentences, so ':' and '.' inside them must stay literal
    keySeparator: false,
    nsSeparator: false,
    // placeholders are written {name}, not the i18next default {{name}}
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
    // an untranslated (empty) Ukrainian value falls back to English instead of rendering ''
    returnEmptyString: false,
    returnNull: false,
  });
  ready = true;
  try {
    document.documentElement.lang = lang;
  } catch {
    /* no document */
  }
}

export function lang(): Lang {
  return current;
}

/** BCP 47 tag for Intl formatters. */
export function locale(): string {
  return current === 'uk' ? 'uk-UA' : 'en-GB';
}

export function i18nReady(): boolean {
  return ready;
}

/**
 * Translate an English source string. `{name}` placeholders are filled from `vars`; pass
 * `count` for plural keys (the key then gets _one / _few / _many / _other forms). Unknown keys return the English
 * text with its placeholders filled.
 */
export function t(key: string, vars?: TVars): string {
  const clean: Record<string, string | number> = {};
  if (vars) for (const [k, v] of Object.entries(vars)) clean[k] = v ?? '';
  if (!ready) return key.replace(/\{(\w+)\}/g, (m, n: string) => (n in clean ? String(clean[n]) : m));
  return i18next.t(key, { ...clean, defaultValue: key });
}
