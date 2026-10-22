/**
 * The order the panel language is chosen in, kept free of the browser so it can be checked on
 * its own: this browser's own choice → the panel language set for everyone → the Home Assistant
 * user's language → the browser languages → English. The setting for everyone comes before the
 * HA user's language on purpose: an administrator who sets it expects it on every HA account,
 * English ones included.
 */
import type { GeneralSettings, Lang } from '@api/model';
import { isLang } from '@i18n';

/** This browser's own choice; 'auto' leaves it to the rest of the order. */
export type LangPref = 'auto' | Lang;

export interface LanguageSources {
  pref: LangPref;
  /** The panel language for everyone; null when the server did not answer in time. */
  everyone: GeneralSettings['uiLanguage'] | null;
  /** The HA user's language tag from the parent frame, e.g. 'uk' or 'en-GB'. */
  ha: string | null;
  /** navigator.languages, most preferred first. */
  browser: readonly string[];
}

/** 'en-GB' → 'en'; null for a language the panel has no dictionary for. */
export function langOfTag(tag: string | null | undefined): Lang | null {
  const b = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return isLang(b) ? b : null;
}

export function pickLanguage(s: LanguageSources): Lang {
  if (s.pref !== 'auto') return s.pref;
  if (s.everyone && s.everyone !== 'auto') return s.everyone;
  for (const tag of [s.ha, ...s.browser]) {
    const l = langOfTag(tag);
    if (l) return l;
  }
  return 'en';
}
