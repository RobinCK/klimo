/**
 * Panel language, resolved once at boot in the order of pickLanguage (langOrder.ts). Changing
 * it reloads the page so every label is rebuilt in the new language.
 */
import type { GeneralSettings, Lang } from '@api/model';
import { api } from '@api/endpoints';
import { isLang, lang } from '@i18n';
import { getPref, setPref } from './prefs';
import { haLanguage } from './haBridge';
import { pickLanguage, type LangPref } from './langOrder';

export type { LangPref };

export function languagePref(): LangPref {
  const v = getPref('lang');
  return isLang(v) ? v : 'auto';
}

export function setLanguagePref(pref: LangPref): void {
  setPref('lang', pref === 'auto' ? null : pref);
  window.location.reload();
}

function browserLanguages(): readonly string[] {
  try {
    return navigator.languages?.length ? navigator.languages : [navigator.language];
  } catch {
    return [];
  }
}

/** The panel language for everyone, without delaying the first paint for more than a moment. */
async function everyoneLanguage(timeoutMs: number): Promise<GeneralSettings['uiLanguage'] | null> {
  try {
    const settings = await Promise.race([api.settings.get(), new Promise<null>((r) => window.setTimeout(() => r(null), timeoutMs))]);
    return settings?.general.uiLanguage ?? null;
  } catch {
    return null;
  }
}

export async function resolveLanguage(): Promise<Lang> {
  const pref = languagePref();
  // a browser with its own choice needs nothing from the server
  const everyone = pref === 'auto' ? await everyoneLanguage(1500) : null;
  return pickLanguage({ pref, everyone, ha: haLanguage(), browser: browserLanguages() });
}

/**
 * A newly saved panel language for everyone, applied in this browser: the page reloads when it
 * changes what is shown here. False when nothing changes — this browser keeps its own choice, or
 * the language is the one already on screen.
 */
export function applyPanelLanguage(everyone: GeneralSettings['uiLanguage']): boolean {
  const next = pickLanguage({ pref: languagePref(), everyone, ha: haLanguage(), browser: browserLanguages() });
  if (next === lang()) return false;
  window.location.reload();
  return true;
}
