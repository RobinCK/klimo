import type { Tone } from '@api/model';

export type ToneVarPart = 'bg' | 'fg' | 'line' | 'solid' | 'ink' | 'halo';

/** `var(--ui-tone-heat-fg)` — the CSS reference components use for a tone colour. */
export function toneVar(tone: Tone, part: ToneVarPart): string {
  return `var(--ui-tone-${tone}-${part})`;
}
