import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

// base './' is mandatory: the app is served behind the HA ingress path prefix.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // the same layer aliases as tsconfig.json; scripts/check-boundaries.mjs polices who may import what
    alias: [
      { find: /^@brand$/, replacement: src('brand/index.ts') },
      { find: /^@ui$/, replacement: src('ui/index.ts') },
      { find: /^@api\/(.*)$/, replacement: src('api/$1') },
      { find: /^@data$/, replacement: src('data/index.ts') },
      { find: /^@i18n$/, replacement: src('i18n/index.ts') },
      { find: /^@app$/, replacement: src('app/index.ts') },
    ],
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8099', ws: true },
    },
  },
  build: {
    // the panel is one SPA with lazily loaded pages; Mantine alone is ~ 400 kB unminified
    chunkSizeWarningLimit: 900,
  },
});
