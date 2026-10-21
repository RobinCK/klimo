import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './theme/global.css';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { BASE_TOKENS, buildTokens, tokensToCss, type BrandTheme, type ColorScheme, type ThemeTokens } from './tokens/build';
import { createUiTheme } from './theme/createUiTheme';
import { UiTextProvider, fillPlaceholders, type UiTextFn } from './UiTextContext';
import { UiNavProvider, type UiNav } from './UiNavContext';

export interface UiProviderProps {
  /** Brand look (logo colours, action colour, fonts, radius scale, optional neutral re-tune). */
  brand: BrandTheme;
  /** Resolved colour scheme; the app decides (stored choice → Home Assistant → device). */
  scheme: ColorScheme;
  /** Translator for kit chrome strings. */
  ut?: UiTextFn;
  /** Route resolution for kit links. */
  nav?: UiNav;
  children: ReactNode;
}

interface UiThemeValue {
  tokens: ThemeTokens;
  scheme: ColorScheme;
}

const UiThemeContext = createContext<UiThemeValue | null>(null);

/** Tokens and the active scheme, for components that need a raw value (canvas, computed contrast). */
export function useUiTheme(): UiThemeValue {
  const v = useContext(UiThemeContext);
  if (!v) throw new Error('useUiTheme() outside <UiProvider>');
  return v;
}

/** Tokens → CSS variables (both schemes) → Mantine theme, plus the text and navigation seams. */
export function UiProvider({ brand, scheme, ut, nav, children }: UiProviderProps) {
  const tokens = useMemo(() => buildTokens(BASE_TOKENS, brand), [brand]);
  const theme = useMemo(() => createUiTheme(tokens, brand), [tokens, brand]);
  const css = useMemo(() => tokensToCss(tokens), [tokens]);
  const value = useMemo(() => ({ tokens, scheme }), [tokens, scheme]);

  // toasts render inside the text and navigation seams so their buttons can use them
  let content = (
    <UiTextProvider ut={ut ?? fillPlaceholders}>
      <Notifications position="top-right" zIndex={400} limit={4} />
      {children}
    </UiTextProvider>
  );
  if (nav) content = <UiNavProvider nav={nav}>{content}</UiNavProvider>;

  return (
    <MantineProvider theme={theme} forceColorScheme={scheme}>
      <style data-ui-tokens="" dangerouslySetInnerHTML={{ __html: css }} />
      <UiThemeContext.Provider value={value}>{content}</UiThemeContext.Provider>
    </MantineProvider>
  );
}
