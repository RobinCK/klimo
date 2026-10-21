import {
  BASE_DARK,
  BASE_LIGHT,
  BASE_TONES,
  CONTROL_HEIGHTS,
  LINE_HEIGHT,
  MOTION_MS,
  PROFILE_COLORS,
  RADII,
  SPACE,
  SPACE_SCALE,
  TONE_ALIASES,
  TYPE,
  type NeutralTokens,
  type ProfileColor,
  type RadiusName,
  type SchemeBase,
} from './base';
import { withAlpha } from './color';

/** Logo construction colours (not semantic tones). */
export interface MarkColors {
  cold: string;
  warm: string;
  dot: string;
  tile: string;
  tileBorder: string;
}

/**
 * What the kit needs from a brand. The brand config in src/brand satisfies it structurally,
 * so the kit never imports the brand and any other brand can be dropped in.
 */
export interface BrandTheme {
  mark: { dark: MarkColors; light: MarkColors };
  action: { dark: { bg: string; fg: string }; light: { bg: string; fg: string } };
  fonts: { sans: string; mono: string };
  radiusScale: number;
  neutrals?: { dark?: Partial<NeutralTokens>; light?: Partial<NeutralTokens> };
}

export type ColorScheme = 'dark' | 'light';

export interface SchemeTokens extends SchemeBase {
  mark: MarkColors;
}

export interface ThemeTokens {
  dark: SchemeTokens;
  light: SchemeTokens;
  profiles: readonly ProfileColor[];
  radii: Record<RadiusName, number>;
  space: typeof SPACE;
  spaceScale: typeof SPACE_SCALE;
  type: typeof TYPE;
  controls: typeof CONTROL_HEIGHTS;
  fonts: { sans: string; mono: string };
  motionMs: number;
  lineHeight: number;
}

export interface BaseTokens {
  dark: SchemeBase;
  light: SchemeBase;
  profiles: readonly ProfileColor[];
}

export const BASE_TOKENS: BaseTokens = { dark: BASE_DARK, light: BASE_LIGHT, profiles: PROFILE_COLORS };

const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO_FALLBACK = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

function scheme(base: SchemeBase, brand: BrandTheme, key: ColorScheme): SchemeTokens {
  return {
    neutrals: { ...base.neutrals, ...(brand.neutrals?.[key] ?? {}) },
    action: { ...brand.action[key] },
    tones: base.tones,
    mark: brand.mark[key],
  };
}

export function buildTokens(base: BaseTokens, brand: BrandTheme): ThemeTokens {
  const scale = Number.isFinite(brand.radiusScale) && brand.radiusScale > 0 ? brand.radiusScale : 1;
  const radii = Object.fromEntries(
    Object.entries(RADII).map(([k, v]) => [k, k === 'pill' ? v : Math.round(v * scale * 10) / 10]),
  ) as Record<RadiusName, number>;
  return {
    dark: scheme(base.dark, brand, 'dark'),
    light: scheme(base.light, brand, 'light'),
    profiles: base.profiles,
    radii,
    space: SPACE,
    spaceScale: SPACE_SCALE,
    type: TYPE,
    controls: CONTROL_HEIGHTS,
    fonts: { sans: `'${brand.fonts.sans}', ${SANS_FALLBACK}`, mono: `'${brand.fonts.mono}', ${MONO_FALLBACK}` },
    motionMs: MOTION_MS,
    lineHeight: LINE_HEIGHT,
  };
}

/** bgPage → bg-page, surface1 → surface-1, h1 → h1, h2Sheet → h2-sheet. */
export function kebab(key: string): string {
  return key
    .replace(/([a-z]{2,})([0-9])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function decls(vars: Record<string, string | number>): string {
  return Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
}

function schemeVars(t: SchemeTokens): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, value] of Object.entries(t.neutrals)) v[`--ui-${kebab(k)}`] = value;
  v['--ui-action-bg'] = t.action.bg;
  v['--ui-action-fg'] = t.action.fg;
  for (const tone of BASE_TONES) {
    const c = t.tones[tone];
    v[`--ui-tone-${tone}-bg`] = c.bg;
    v[`--ui-tone-${tone}-fg`] = c.fg;
    v[`--ui-tone-${tone}-line`] = c.line;
    v[`--ui-tone-${tone}-solid`] = c.solid;
    v[`--ui-tone-${tone}-ink`] = c.ink;
    v[`--ui-tone-${tone}-halo`] = withAlpha(c.line, 0.18);
  }
  for (const [alias, tone] of Object.entries(TONE_ALIASES)) {
    for (const part of ['bg', 'fg', 'line', 'solid', 'ink', 'halo']) v[`--ui-tone-${alias}-${part}`] = `var(--ui-tone-${tone}-${part})`;
  }
  v['--brand-cold'] = t.mark.cold;
  v['--brand-warm'] = t.mark.warm;
  v['--brand-dot'] = t.mark.dot;
  v['--brand-tile'] = t.mark.tile;
  v['--brand-tile-border'] = t.mark.tileBorder;
  // Mantine reads these; pointing them at the tokens keeps its own components on-palette
  v['--mantine-color-body'] = t.neutrals.bgPage;
  v['--mantine-color-text'] = t.neutrals.text1;
  v['--mantine-color-dimmed'] = t.neutrals.text3;
  v['--mantine-color-placeholder'] = t.neutrals.text3;
  v['--mantine-color-anchor'] = t.neutrals.text1;
  v['--mantine-color-default'] = t.neutrals.surface2;
  v['--mantine-color-default-hover'] = t.neutrals.surface3;
  v['--mantine-color-default-color'] = t.neutrals.text1;
  v['--mantine-color-default-border'] = t.neutrals.borderStrong;
  v['--mantine-color-error'] = t.tones.err.fg;
  return v;
}

function sharedVars(t: ThemeTokens): Record<string, string> {
  const v: Record<string, string> = {
    '--ui-font-sans': t.fonts.sans,
    '--ui-font-mono': t.fonts.mono,
    '--ui-line-height': String(t.lineHeight),
    '--ui-motion': `${t.motionMs}ms`,
    '--ui-gutter': 'clamp(16px, 3vw, 24px)',
    '--ui-content-max': '1360px',
  };
  for (const [k, r] of Object.entries(t.radii)) v[`--ui-radius-${k}`] = `${r}px`;
  for (const s of t.spaceScale) v[`--ui-space-${s}`] = `${s}px`;
  for (const [k, s] of Object.entries(t.space)) v[`--ui-gap-${k}`] = `${s}px`;
  for (const h of t.controls) v[`--ui-h-${h}`] = `${h}px`;
  for (const [k, step] of Object.entries(t.type)) {
    const name = kebab(k);
    v[`--ui-fs-${name}`] = step.size;
    v[`--ui-fw-${name}`] = String(step.weight);
    v[`--ui-ls-${name}`] = step.tracking;
  }
  t.profiles.forEach((p, i) => {
    v[`--ui-profile-${i + 1}`] = p.color;
    v[`--ui-profile-${i + 1}-ink`] = p.ink;
  });
  return v;
}

/**
 * CSS for both schemes. The doubled :root is deliberate: MantineProvider writes its own
 * colour variables at runtime into a style tag appended after ours, at the same
 * specificity, so a single :root would lose the tie. The `[data-ui-scheme]` blocks let a
 * subtree show the other scheme (previews, the component gallery).
 */
export function tokensToCss(t: ThemeTokens): string {
  const dark = decls(schemeVars(t.dark));
  const light = decls(schemeVars(t.light));
  return [
    `:root {\n${decls(sharedVars(t))}\n}`,
    `:root:root[data-mantine-color-scheme='dark'] {\n${dark}\n  color-scheme: dark;\n}`,
    `:root:root[data-mantine-color-scheme='light'] {\n${light}\n  color-scheme: light;\n}`,
    `[data-ui-scheme='dark'][data-ui-scheme] {\n${dark}\n  color-scheme: dark;\n}`,
    `[data-ui-scheme='light'][data-ui-scheme] {\n${light}\n  color-scheme: light;\n}`,
  ].join('\n');
}
