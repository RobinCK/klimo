import type { ReactNode } from 'react';
import s from './gallery.module.css';

/** A group of the gallery («Containers», «Inputs» …). */
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

export { s as galleryStyles };
