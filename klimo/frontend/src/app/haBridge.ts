/**
 * The panel runs as a same-origin ingress iframe inside the Home Assistant frontend, so it can
 * read the parent's `hass` object for things HA does not pass to add-ons: the dark-mode flag
 * and the user's language. Everything is best effort — outside HA (dev server, direct port)
 * or with a cross-origin parent the getters return null.
 */

interface ParentHass {
  themes?: { darkMode?: boolean };
  locale?: { language?: string };
  language?: string;
  user?: { id?: string; name?: string; is_admin?: boolean };
}

export function parentHass(): ParentHass | null {
  try {
    if (window.parent === window) return null;
    const el = window.parent.document.querySelector('home-assistant') as (Element & { hass?: ParentHass }) | null;
    return el?.hass ?? null;
  } catch {
    return null;
  }
}

/** Running inside the Home Assistant frontend. */
export function inHomeAssistant(): boolean {
  return parentHass() !== null;
}

export function haDarkMode(): boolean | null {
  const v = parentHass()?.themes?.darkMode;
  return typeof v === 'boolean' ? v : null;
}

/** The HA user's language, e.g. 'uk' or 'en-GB'. */
export function haLanguage(): string | null {
  const h = parentHass();
  return h?.locale?.language ?? h?.language ?? null;
}
