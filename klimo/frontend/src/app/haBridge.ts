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

/**
 * Home Assistant's own dialog of an entity — its state, history chart and settings — over the panel.
 * False outside HA (nothing was opened).
 */
export function openHaMoreInfo(entityId: string): boolean {
  try {
    if (window.parent === window) return false;
    const el = window.parent.document.querySelector('home-assistant');
    if (!el) return false;
    el.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
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

/**
 * The screen's notch or island and its home bar as they reach into this frame. iOS gives safe-area
 * insets to the top document only, so `env(safe-area-inset-*)` is 0 inside the ingress iframe: the
 * insets are read from the page around it, less what lies between the frame and the screen's edge
 * (under Home Assistant's toolbar the top one is already clear). They land on this document as
 * `--ui-frame-safe-top` / `--ui-frame-safe-bottom`, which the kit's `--ui-safe-*` take into account.
 */
export function watchFrameSafeArea(): void {
  const root = document.documentElement;
  let probe: HTMLElement | null = null;
  const apply = () => {
    let top = 0;
    let bottom = 0;
    try {
      const frame = window.frameElement;
      if (frame && window.parent !== window) {
        const doc = window.parent.document;
        if (!probe || !probe.isConnected) {
          probe = doc.createElement('div');
          probe.style.cssText =
            'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
          doc.body.appendChild(probe);
        }
        const cs = window.parent.getComputedStyle(probe);
        const r = frame.getBoundingClientRect();
        top = Math.max(0, Math.round((parseFloat(cs.paddingTop) || 0) - r.top));
        bottom = Math.max(0, Math.round((parseFloat(cs.paddingBottom) || 0) - (window.parent.innerHeight - r.bottom)));
      }
    } catch {
      // a parent of another origin: the frame's own env() is all there is
    }
    root.style.setProperty('--ui-frame-safe-top', `${top}px`);
    root.style.setProperty('--ui-frame-safe-bottom', `${bottom}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  try {
    window.parent.addEventListener('resize', apply);
  } catch {
    // another origin
  }
  // Home Assistant's toolbar can come and go (full screen, kiosk): look again now and then
  window.setInterval(apply, 3000);
}
