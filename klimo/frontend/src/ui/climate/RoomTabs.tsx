import { useEffect, useRef, type CSSProperties } from 'react';
import type { Tone } from '../types';
import { toneVar } from '../tokens/vars';
import { useUiNav } from '../UiNavContext';
import { useUiText } from '../UiTextContext';
import { useRouteClick } from '../shell/Link';
import { Icon } from '../basic/Icon';
import s from './climate.module.css';

export interface RoomTabsProps {
  rooms: readonly { id: string; name: string; tempText: string; dotTone: Tone }[];
  /** Id of the open room. */
  current: string;
  /** Route of a room («/rooms/living»). */
  hrefFor: (id: string) => string;
  /** Route of the add-room wizard. */
  addTo: string;
  addLabel: string;
  ariaLabel?: string;
}

function Tab({ to, current, name, tempText, dotTone }: { to: string; current: boolean; name: string; tempText: string; dotTone: Tone }) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return (
    <a
      className={s.tab}
      href={nav.href(to)}
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      data-current={current ? '' : undefined}
      style={{ '--dot': toneVar(dotTone, 'line') } as CSSProperties}
    >
      <span className={s.tabDot} aria-hidden="true" />
      <span className={s.tabName}>{name}</span>
      <span className={s.tabTemp}>{tempText}</span>
    </a>
  );
}

/** Scrollable room switcher above the room page, with an add tile at the end. */
export function RoomTabs({ rooms, current, hrefFor, addTo, addLabel, ariaLabel }: RoomTabsProps) {
  const nav = useUiNav();
  const ut = useUiText();
  const onAdd = useRouteClick(addTo);
  const strip = useRef<HTMLElement>(null);

  useEffect(() => {
    // bring the open room into view inside the strip only — never scroll the page
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>('[data-current]');
    if (!el || !tab) return;
    const left = tab.offsetLeft; // the strip is positioned, so this is relative to it
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 8);
    else if (left + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + tab.offsetWidth - el.clientWidth + 8;
  }, [current, rooms.length]);

  return (
    <nav ref={strip} className={s.tabs} aria-label={ariaLabel ?? ut('Rooms')}>
      <div className={s.tabsInner}>
        {rooms.map((r) => (
          <Tab key={r.id} to={hrefFor(r.id)} current={r.id === current} name={r.name} tempText={r.tempText} dotTone={r.dotTone} />
        ))}
        <a className={s.tabAdd} href={nav.href(addTo)} onClick={onAdd} aria-label={addLabel} title={addLabel}>
          <Icon name="plus" size={18} />
        </a>
      </div>
    </nav>
  );
}
