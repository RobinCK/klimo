import React from 'react';
import ReactDOM from 'react-dom/client';
import { brand } from '@brand';
import { initI18n } from '@i18n';
import { Root, bootRouter, resolveLanguage, watchFrameSafeArea } from '@app';

// The language decides every label, so it is settled before the first render; the route is
// resolved before it too, so the first frame is already the right page.
async function boot(): Promise<void> {
  document.title = brand.productName;
  // the notch and the home bar, also inside Home Assistant's iframe, where iOS reports none
  watchFrameSafeArea();
  await initI18n(await resolveLanguage());
  bootRouter();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

void boot();
