import type { ReactNode } from 'react';
import type { ColorScheme } from '../tokens/build';
import s from './shell.module.css';

/** Renders its children in the given colour scheme regardless of the page's (previews, gallery). */
export function SchemeScope({ scheme, children }: { scheme: ColorScheme; children: ReactNode }) {
  return (
    <div className={s.schemeScope} data-ui-scheme={scheme} data-mantine-color-scheme={scheme}>
      {children}
    </div>
  );
}
