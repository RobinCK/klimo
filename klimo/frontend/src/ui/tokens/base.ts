/**
 * The single source of the design tokens. Everything else is derived from this file:
 * CSS variables (tokensToCss), the Mantine theme (createUiTheme) and the token block of
 * the Lovelace cards (`npm run tokens:card` copies these values into klimo-cards.js).
 *
 * Keep it plain data without imports: scripts/tokens-to-card.mjs loads it outside Vite.
 *
 * Tone hues belong to the kit, not to the brand. Orange and blue mean heat and cold and
 * nothing else; a brand may re-tune neutrals, the logo, the action colour, fonts and radii.
 */

export interface NeutralTokens {
  bgPage: string;
  bgChrome: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceElevated: string;
  shadowElevated: string;
  border: string;
  borderStrong: string;
  divider: string;
  ring: string;
  track: string;
  dot: string;
  controlOff: string;
  text1: string;
  text2: string;
  text3: string;
  textNeutralStrong: string;
  textDisabled: string;
  band: string;
  scrim: string;
}

export interface ToneTokens {
  bg: string;
  fg: string;
  line: string;
  /** Solid fill for counters and pins, with the ink that reads on it. */
  solid: string;
  ink: string;
}

export const BASE_TONES = ['heat', 'cool', 'hold', 'warn', 'err', 'off', 'ok', 'event'] as const;
export type BaseTone = (typeof BASE_TONES)[number];

/** Schema node tones that reuse a base tone (drawn dashed while not running). */
export const TONE_ALIASES = { wait: 'heat', idle: 'off', mixed: 'hold' } as const;

export interface SchemeBase {
  neutrals: NeutralTokens;
  action: { bg: string; fg: string };
  tones: Record<BaseTone, ToneTokens>;
}

export interface ProfileColor {
  color: string;
  ink: string;
}

export const BASE_DARK: SchemeBase = {
  neutrals: {
    bgPage: '#0E1013',
    bgChrome: '#121417',
    surface1: '#171A1E',
    surface2: '#1F2328',
    surface3: '#272C32',
    surface4: '#2E333A',
    surfaceElevated: '#2A2E34',
    shadowElevated: '0 8px 24px rgba(0,0,0,.35)',
    border: '#2A2F36',
    borderStrong: '#343A42',
    divider: '#23272D',
    ring: '#4A515A',
    track: '#262A30',
    dot: '#3A4048',
    controlOff: '#5A616B',
    text1: '#ECEEF1',
    text2: '#B3BAC3',
    text3: '#8C949E',
    textNeutralStrong: '#D5D9DE',
    textDisabled: '#6B737D',
    band: 'rgba(236,238,241,.09)',
    scrim: 'rgba(5,6,8,.62)',
  },
  action: { bg: '#ECEEF1', fg: '#0E1013' },
  tones: {
    heat: { bg: 'rgba(255,138,61,.15)', fg: '#FFB27A', line: '#FF8A3D', solid: '#FF8A3D', ink: '#2A1204' },
    cool: { bg: 'rgba(77,166,255,.15)', fg: '#9CCBFF', line: '#4DA6FF', solid: '#4DA6FF', ink: '#04172A' },
    hold: { bg: '#23272D', fg: '#D5D9DE', line: '#D5D9DE', solid: '#D5D9DE', ink: '#0E1013' },
    warn: { bg: 'rgba(242,193,78,.15)', fg: '#F5D57E', line: '#F2C14E', solid: '#F2C14E', ink: '#1E1603' },
    err: { bg: 'rgba(240,113,107,.15)', fg: '#FF9F9A', line: '#F0716B', solid: '#F0716B', ink: '#2B0A08' },
    off: { bg: '#1F2328', fg: '#9AA2AC', line: '#8C949E', solid: '#5A616B', ink: '#ECEEF1' },
    ok: { bg: 'rgba(76,195,138,.13)', fg: '#8FE0B5', line: '#4CC38A', solid: '#4CC38A', ink: '#04201A' },
    event: { bg: 'rgba(155,135,245,.12)', fg: '#CFC5FF', line: '#9B87F5', solid: '#9B87F5', ink: '#140F2E' },
  },
};

export const BASE_LIGHT: SchemeBase = {
  neutrals: {
    bgPage: '#F2F3F5',
    bgChrome: '#FFFFFF',
    surface1: '#FFFFFF',
    surface2: '#F4F5F7',
    surface3: '#E9EBEF',
    surface4: '#E3E6EA',
    surfaceElevated: '#FFFFFF',
    shadowElevated: '0 8px 24px rgba(20,23,26,.12)',
    border: '#E1E4E9',
    borderStrong: '#D3D7DD',
    divider: '#E9EBEF',
    ring: '#B9BFC8',
    track: '#E6E8EC',
    dot: '#C9CED6',
    controlOff: '#9AA1AA',
    text1: '#14171A',
    text2: '#454D57',
    text3: '#646C76',
    textNeutralStrong: '#343B44',
    textDisabled: '#9AA1AA',
    band: 'rgba(20,23,26,.07)',
    scrim: 'rgba(5,6,8,.62)',
  },
  action: { bg: '#14171A', fg: '#FFFFFF' },
  tones: {
    heat: { bg: '#FFEADB', fg: '#A84A0C', line: '#E8701F', solid: '#C75A12', ink: '#FFFFFF' },
    cool: { bg: '#E2EEFC', fg: '#1D64B3', line: '#2F86E0', solid: '#1D6FC4', ink: '#FFFFFF' },
    hold: { bg: '#EEF0F3', fg: '#343B44', line: '#343B44', solid: '#343B44', ink: '#FFFFFF' },
    warn: { bg: '#FFF1CC', fg: '#7D5700', line: '#C48F00', solid: '#F2C14E', ink: '#1E1603' },
    err: { bg: '#FCE6E4', fg: '#A8261C', line: '#D9483D', solid: '#C23A2F', ink: '#FFFFFF' },
    off: { bg: '#F1F2F4', fg: '#5A626C', line: '#646C76', solid: '#646C76', ink: '#FFFFFF' },
    ok: { bg: '#DDF3E7', fg: '#1A7149', line: '#1E8A57', solid: '#1A7149', ink: '#FFFFFF' },
    event: { bg: '#EEEAFE', fg: '#5B47C9', line: '#7C68E6', solid: '#5B47C9', ink: '#FFFFFF' },
  },
};

/** Categorical profile colours (never used for state). The first six are the seeded profiles. */
export const PROFILE_COLORS: readonly ProfileColor[] = [
  { color: '#9B87F5', ink: '#140F2E' }, // home
  { color: '#7D8896', ink: '#0E1013' }, // away
  { color: '#57C48B', ink: '#062012' }, // eco
  { color: '#4F5FD6', ink: '#FFFFFF' }, // night
  { color: '#E87AB4', ink: '#2A0718' }, // guests
  { color: '#C9B56E', ink: '#231D05' }, // vacation
  { color: '#3BB6B0', ink: '#04201F' },
  { color: '#F07C5A', ink: '#2A0B04' },
  { color: '#A6C94A', ink: '#172003' },
  { color: '#5AA9E6', ink: '#04172A' },
  { color: '#B57EDC', ink: '#1E0B2A' },
  { color: '#A39E93', ink: '#16140F' },
];

/** Radii in px before the brand's radius scale is applied ('pill' is never scaled). */
export const RADII = {
  xs: 3,
  sm: 6,
  chip: 8,
  md: 10,
  lg: 12,
  xl: 14,
  '2xl': 16,
  '3xl': 18,
  section: 22,
  sheet: 24,
  pill: 999,
} as const;
export type RadiusName = keyof typeof RADII;

/** The spacing scale in px. */
export const SPACE_SCALE = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56] as const;

/** Named gaps for layout props (`gap="md"`), a subset of the scale. */
export const SPACE = {
  '3xs': 2,
  '2xs': 4,
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
} as const;
export type SpaceName = keyof typeof SPACE;

export interface TypeStep {
  size: string;
  weight: number;
  tracking: string;
  lineHeight?: number;
}

export const TYPE = {
  micro: { size: '11px', weight: 600, tracking: '0' },
  caption: { size: '12px', weight: 400, tracking: '0' },
  bodySm: { size: '13px', weight: 400, tracking: '0' },
  body: { size: '14px', weight: 400, tracking: '0' },
  bodyLg: { size: '15px', weight: 400, tracking: '0' },
  titleSm: { size: '16px', weight: 600, tracking: '0' },
  title: { size: '17px', weight: 600, tracking: '0' },
  titleLg: { size: '19px', weight: 600, tracking: '-0.2px' },
  value: { size: '22px', weight: 500, tracking: '-0.3px', lineHeight: 1.15 },
  h1: { size: 'clamp(24px, 3vw, 30px)', weight: 600, tracking: '-0.5px', lineHeight: 1.2 },
  h2Sheet: { size: '28px', weight: 600, tracking: '-0.4px', lineHeight: 1.2 },
  dual: { size: '30px', weight: 500, tracking: '-0.5px', lineHeight: 1.1 },
  metric: { size: '40px', weight: 500, tracking: '-1.2px', lineHeight: 1 },
  display: { size: '64px', weight: 500, tracking: '-2px', lineHeight: 1 },
  dial: { size: '66px', weight: 400, tracking: '-2px', lineHeight: 1 },
} as const satisfies Record<string, TypeStep>;
export type TypeName = keyof typeof TYPE;

/** Control heights in px (chips 24/26, segments 34–40, buttons 44, steppers 48, mobile primary 52 …). */
export const CONTROL_HEIGHTS = [24, 26, 34, 36, 38, 40, 44, 48, 52, 56, 64] as const;

export const MOTION_MS = 150;
export const LINE_HEIGHT = 1.45;
