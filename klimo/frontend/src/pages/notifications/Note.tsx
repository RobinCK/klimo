import { Section } from '@ui';

/**
 * A short explanatory paragraph inside a card. The kit has no bare text block, so it is a
 * header-only plain section, which carries the kit's quiet text style.
 */
export function Note({ text }: { text: string }) {
  return <Section variant="plain" level={3} subtitle={text} />;
}
