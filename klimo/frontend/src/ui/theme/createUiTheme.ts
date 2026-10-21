import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Menu,
  Modal,
  Paper,
  Popover,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
  Tooltip,
  createTheme,
  virtualColor,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core';
import type { BrandTheme, ThemeTokens } from '../tokens/build';
import { ramp } from '../tokens/color';

const tuple = (shades: string[]) => shades as unknown as MantineColorsTuple;

/**
 * Mantine theme from the tokens. Actions are neutral: the primary colour is a grey ramp
 * built from the brand's action colour (light ink on dark, dark ink on light), never a
 * tone. Tones are registered as colours for the few Mantine internals that take a colour
 * name; kit components paint with the --ui-tone-* variables directly.
 */
export function createUiTheme(tokens: ThemeTokens, brand: BrandTheme): MantineThemeOverride {
  const r = tokens.radii;
  const tones = ['heat', 'cool', 'warn', 'err', 'ok', 'event'] as const;
  const colors: Record<string, MantineColorsTuple> = {
    neutralDark: tuple(ramp(brand.action.dark.bg)),
    neutralLight: tuple(ramp(brand.action.light.bg)),
  };
  for (const tone of tones) {
    colors[`${tone}Dark`] = tuple(ramp(tokens.dark.tones[tone].line));
    colors[`${tone}Light`] = tuple(ramp(tokens.light.tones[tone].line));
  }
  const virtual = Object.fromEntries(
    ['neutral', ...tones].map((name) => [name, virtualColor({ name, dark: `${name}Dark`, light: `${name}Light` })]),
  );

  return createTheme({
    colors: { ...colors, ...virtual },
    primaryColor: 'neutral',
    primaryShade: 6,
    autoContrast: true,
    luminanceThreshold: 0.4,
    white: '#FFFFFF',
    black: tokens.light.neutrals.text1,
    fontFamily: tokens.fonts.sans,
    fontFamilyMonospace: tokens.fonts.mono,
    headings: { fontFamily: tokens.fonts.sans, fontWeight: '600' },
    defaultRadius: 'lg',
    radius: { xs: `${r.xs}px`, sm: `${r.sm}px`, md: `${r.md}px`, lg: `${r.lg}px`, xl: `${r['3xl']}px` },
    spacing: { xs: '8px', sm: '12px', md: '16px', lg: '20px', xl: '24px' },
    fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '15px', xl: '17px' },
    lineHeights: { xs: '1.4', sm: '1.45', md: '1.45', lg: '1.45', xl: '1.4' },
    cursorType: 'pointer',
    focusRing: 'never',
    respectReducedMotion: true,
    components: {
      Card: Card.extend({ defaultProps: { radius: r['3xl'], withBorder: true } }),
      Paper: Paper.extend({ defaultProps: { radius: r['3xl'] } }),
      Modal: Modal.extend({
        defaultProps: { radius: r['3xl'], centered: true, overlayProps: { backgroundOpacity: 0.62, blur: 3 } },
      }),
      Drawer: Drawer.extend({ defaultProps: { overlayProps: { backgroundOpacity: 0.62, blur: 3 } } }),
      Button: Button.extend({ defaultProps: { radius: r.lg } }),
      ActionIcon: ActionIcon.extend({ defaultProps: { radius: r.lg, variant: 'default' } }),
      SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: r.lg } }),
      Tooltip: Tooltip.extend({ defaultProps: { radius: r.md, withArrow: true } }),
      Badge: Badge.extend({ defaultProps: { radius: r.sm } }),
      Popover: Popover.extend({ defaultProps: { radius: r.lg, shadow: 'md' } }),
      Menu: Menu.extend({ defaultProps: { radius: r.lg, shadow: 'md' } }),
      Select: Select.extend({ defaultProps: { radius: r.md } }),
      TextInput: TextInput.extend({ defaultProps: { radius: r.lg } }),
      Checkbox: Checkbox.extend({ defaultProps: { color: 'neutral' } }),
      Switch: Switch.extend({ defaultProps: { color: 'neutral' } }),
    },
  });
}
