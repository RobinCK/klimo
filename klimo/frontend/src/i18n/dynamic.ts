/**
 * Keys the UI builds at runtime instead of writing as literals (`t(value)` over data).
 * Static extraction cannot see those calls, so every such key must be declared here as a
 * literal call of t: `npm run i18n` then keeps it in the dictionaries.
 *
 * The shared layers render every enum and code through literal tables (labels.ts, codes.ts),
 * so nothing is dynamic yet; a page that translates data values adds its keys here.
 *
 * Nothing imports this module at runtime; it exists for the extractor.
 */
export const DYNAMIC_KEYS: readonly string[] = [];
