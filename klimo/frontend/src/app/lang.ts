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

type UiLanguage = GeneralSettings['uiLanguage'];

const isUiLanguage = (v: unknown): v is UiLanguage => v === 'auto' || isLang(v);

function rememberEveryone(v: UiLanguage): UiLanguage {
  setPref('panelLang', v);
  return v;
}

/**
 * The panel language for everyone, without delaying the first paint for more than a moment. A
 * late or failed answer falls back to the value this browser saw last: a busy Home Assistant
 * must not show the panel in the HA user's language instead for one visit.
 */
async function everyoneLanguage(timeoutMs: number): Promise<UiLanguage | null> {
  const fresh = api.settings.get().then(
    (s) => rememberEveryone(s.general.uiLanguage),
    () => null,
  );
  const late = new Promise<null>((r) => window.setTimeout(() => r(null), timeoutMs));
  const v = await Promise.race([fresh, late]);
  if (v) return v;
  const seen = getPref('panelLang');
  return isUiLanguage(seen) ? seen : null;
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
export function applyPanelLanguage(everyone: UiLanguage): boolean {
  rememberEveryone(everyone);
  const next = pickLanguage({ pref: languagePref(), everyone, ha: haLanguage(), browser: browserLanguages() });
  if (next === lang()) return false;
  window.location.reload();
  return true;
}
