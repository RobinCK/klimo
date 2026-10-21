/**
 * Keeps src/locales/<lang>.json in sync with the t() and ut() calls in the code:
 * new strings are added, strings no longer used are removed.
 *
 *   npm run i18n            update the dictionaries
 *   npm run i18n:check      fail if they are out of date or Ukrainian has gaps
 *   npm run locales:merge   fold src/locales/parts/*.json into the dictionaries
 *
 * Keys are the English source text, so en.json is the list of source strings and
 * a language file only needs the keys it actually translates. t() is the app and
 * page translator, ut() the UI-kit one (strings reach @ui through UiTextContext).
 */
export default {
  locales: ['en', 'uk'],
  input: ['src/**/*.{ts,tsx}'],
  output: 'src/locales/$LOCALE.json',
  lexers: {
    ts: [{ lexer: 'JavascriptLexer', functions: ['t', 'ut'] }],
    tsx: [{ lexer: 'JsxLexer', functions: ['t', 'ut'] }],
    default: [{ lexer: 'JavascriptLexer', functions: ['t', 'ut'] }],
  },

  // keys are English sentences: ':' and '.' inside them are literal, and
  // placeholders are written {name} rather than the i18next default {{name}}
  keySeparator: false,
  namespaceSeparator: false,
  pluralSeparator: '_',
  defaultNamespace: 'translation',

  // English needs no translation step — its value is the key itself
  defaultValue: (locale, _namespace, key) => (locale === 'en' ? key : ''),
  keepRemoved: false,
  sort: true,
  createOldCatalogs: false,
  indentation: 2,
  lineEnding: 'lf',
};
