// The UI-kit: tokens → CSS variables → Mantine theme, icons, shell, components.
// Brand-neutral by construction: the brand comes in through UiProvider, strings through
// UiTextContext and navigation through UiNavContext.
export * from './types';
export * from './tokens';
export * from './icons';
export * from './shell';
export * from './basic';
export { UiProvider, useUiTheme, type UiProviderProps } from './UiProvider';
export { UiTextProvider, fillPlaceholders, useUiText, type UiTextFn, type UiTextVars } from './UiTextContext';
export { UiNavProvider, useUiNav, type UiNav } from './UiNavContext';
export * from './kit';
export * from './viz';
export * from './climate';
