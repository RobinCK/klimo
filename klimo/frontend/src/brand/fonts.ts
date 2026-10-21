// Bundled fonts: the panel runs behind ingress and may have no internet access, so nothing
// is fetched from a font CDN. Ukrainian needs the Cyrillic subset; the mono face is only
// used for Home Assistant entity ids, which are ASCII.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-sans/cyrillic-400.css';
import '@fontsource/ibm-plex-sans/cyrillic-500.css';
import '@fontsource/ibm-plex-sans/cyrillic-600.css';
import '@fontsource/ibm-plex-sans/cyrillic-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
