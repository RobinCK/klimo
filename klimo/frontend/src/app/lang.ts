/**
 * Panel language: the stored choice → the Home Assistant user's language (parent frame) →
 * the add-on's default UI language → the browser languages → English. Resolved once at boot;
 * changing it reloads the page so every label is rebuilt in the new language.
 */
import type { Lang } from '@api/model';
import { api } from '@api/endpoints';
import { isLang } from '@i18n';
import { getPref, setPref } from './prefs';
import { haLanguage } from './haBridge';

export type LangPref = 'auto' | Lang;

export function languagePref(): LangPref {
  const v = getPref('lang');
  return isLang(v) ? v : 'auto';
}

export function setLanguagePref(pref: LangPref): void {
  setPref('lang', pref === 'auto' ? null : pref);
  window.location.reload();
}

const base = (tag: string | null | undefined): Lang | null => {
  const b = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return isLang(b) ? b : null;
};

/** The server's default, without delaying the first paint for more than a moment. */
async function serverLanguage(timeoutMs: number): Promise<Lang | null> {
  try {
    const settings = await Promise.race([api.settings.get(), new Promise<null>((r) => window.setTimeout(() => r(null), timeoutMs))]);
    const ui = settings?.general.uiLanguage;
    return ui && ui !== 'auto' ? ui : null;
  } catch {
    return null;
  }
}

export async function resolveLanguage(): Promise<Lang> {
  const pref = languagePref();
  if (pref !== 'auto') return pref;
  const ha = base(haLanguage());
  if (ha) return ha;
  const server = await serverLanguage(1500);
  if (server) return server;
  try {
    for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const b = base(l);
      if (b) return b;
    }
  } catch {
    /* no navigator */
  }
  return 'en';
}
