import type { ReactNode } from 'react';
import s from './gallery.module.css';

/** A group of the gallery («Charts», «Plant» …). */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={s.group} aria-label={title}>
      <h2 className={s.groupTitle}>{title}</h2>
      {children}
    </section>
  );
}

/** One component with its name in mono above the examples. */
export function Item({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className={s.item}>
      <span className={s.itemName}>{name}</span>
      {children}
    </div>
  );
}

/** A card-coloured panel, as most of these components sit on a card in the app. */
export function Panel({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className={s.panel} data-narrow={narrow ? '' : undefined}>
      {children}
    </div>
  );
}

/** Two-up grid for small variants. */
export function Pair({ children, min = 240 }: { children: ReactNode; min?: number }) {
  return (
    <div className={s.pair} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}>
      {children}
    </div>
  );
}

export { s as galleryStyles };
