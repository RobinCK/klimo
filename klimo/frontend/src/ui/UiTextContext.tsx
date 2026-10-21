import { createContext, useContext, type ReactNode } from 'react';

export type UiTextVars = Record<string, string | number>;

/**
 * Translator for the kit's own chrome strings («Скасувати», «Закрити», aria labels).
 * Keys are the English text, exactly like the app's t(); the app plugs i18next in.
 * Inside kit components always name it `ut` — the string extractor looks for calls of a function named ut.
 */
export type UiTextFn = (key: string, vars?: UiTextVars) => string;

/** Without a provider the English key is shown with its {placeholders} filled in. */
export const fillPlaceholders: UiTextFn = (key, vars) =>
  vars ? key.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : key;

const UiTextContext = createContext<UiTextFn>(fillPlaceholders);

export function UiTextProvider({ ut, children }: { ut: UiTextFn; children: ReactNode }) {
  return <UiTextContext.Provider value={ut}>{children}</UiTextContext.Provider>;
}

export function useUiText(): UiTextFn {
  return useContext(UiTextContext);
}
