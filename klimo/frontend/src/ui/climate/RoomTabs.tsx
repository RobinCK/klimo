import { useEffect, useRef, type CSSProperties } from 'react';
import type { Tone } from '../types';
import { toneVar } from '../tokens/vars';
import { useUiNav } from '../UiNavContext';
import { useUiText } from '../UiTextContext';
import { useRouteClick } from '../shell/Link';
import { Icon } from '../basic/Icon';
import { VisuallyHidden } from '../basic/VisuallyHidden';
import s from './climate.module.css';

export interface RoomTabsProps {
  /** `demand`: the room asks for heat or cooling right now (a flame or a snowflake after the temperature). */
  rooms: readonly { id: string; name: string; tempText: string; dotTone: Tone; demand?: { kind: 'heat' | 'cool'; label: string } | null }[];
  /** Id of the open room. */
  current: string;
  /** Route of a room («/rooms/living»). */
  hrefFor: (id: string) => string;
  /** Route of the add-room wizard. */
  addTo: string;
  addLabel: string;
  /** A button after the add tile that changes the order of the rooms. */
  order?: { label: string; onClick: () => void };
  ariaLabel?: string;
}

function Tab({
  to,
  current,
  name,
  tempText,
  dotTone,
  demand,
}: {
  to: string;
  current: boolean;
  name: string;
  tempText: string;
  dotTone: Tone;
  demand?: { kind: 'heat' | 'cool'; label: string } | null;
}) {
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
      {demand ? (
        <span className={s.tabDemand} style={{ color: toneVar(demand.kind, 'line') }} title={demand.label}>
          <Icon name={demand.kind === 'heat' ? 'flame' : 'snow'} size={14} />
          <VisuallyHidden>{demand.label}</VisuallyHidden>
        </span>
      ) : null}
    </a>
  );
}

/** Scrollable room switcher above the room page, with an add tile at the end. */
export function RoomTabs({ rooms, current, hrefFor, addTo, addLabel, order, ariaLabel }: RoomTabsProps) {
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
          <Tab key={r.id} to={hrefFor(r.id)} current={r.id === current} name={r.name} tempText={r.tempText} dotTone={r.dotTone} demand={r.demand} />
        ))}
        <a className={s.tabAdd} href={nav.href(addTo)} onClick={onAdd} aria-label={addLabel} title={addLabel}>
          <Icon name="plus" size={18} />
        </a>
        {order ? (
          <button type="button" className={s.tabAdd} onClick={order.onClick} aria-label={order.label} title={order.label}>
            <Icon name="grip" size={18} />
          </button>
        ) : null}
      </div>
    </nav>
  );
}
