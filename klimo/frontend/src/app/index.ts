// App wiring: router, navigation, colour scheme, language, per-browser preferences.
export { App, Root } from './App';
export { AppBanners, HouseSeasonPill, InboxBell } from './Chrome';
export { haDarkMode, haLanguage, inHomeAssistant } from './haBridge';
export { applyPanelLanguage, languagePref, resolveLanguage, setLanguagePref, type LangPref } from './lang';
export { areaOf, desktopNav, phoneNav, phoneTabOf, type AreaKey } from './nav';
export { getJsonPref, getPref, setJsonPref, setPref, usePref } from './prefs';
export {
  RouteScope,
  bootRouter,
  currentRoute,
  href,
  navigate,
  parseRoute,
  paths,
  previousRoute,
  useLeaveGuard,
  useRoute,
  type Route,
  type RouteName,
} from './router';
export { resolveScheme, schemePref, setSchemePref, useColorScheme, type SchemePref } from './scheme';
