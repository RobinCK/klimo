import { Popover } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useUiText } from '../UiTextContext';
import { Icon } from './Icon';
import s from './InfoHint.module.css';

/** One paragraph of a hint; a `lead` is a short bold lead-in («Порожньо:»). */
export type InfoHintParagraph = string | { lead: string; text: string };

/** What a hint says: an optional title line, 1–4 short paragraphs and/or bullets. A string is one paragraph. */
export type InfoHintContent =
  | string
  | {
      title?: string;
      text?: InfoHintParagraph | readonly InfoHintParagraph[];
      bullets?: readonly string[];
    };

export interface InfoHintProps {
  content: InfoHintContent;
  /** What it explains («Таймер реле»); names the button «Пояснення: Таймер реле». */
  subject?: string;
  /** The button's full accessible name (wins over `subject`). */
  label?: string;
  /** Preferred side; it flips when there is no room. */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 120;

function parts(content: InfoHintContent) {
  if (typeof content === 'string') return { title: undefined, paragraphs: [content], bullets: [] as readonly string[] };
  const text = content.text;
  const paragraphs: readonly InfoHintParagraph[] = text === undefined ? [] : typeof text === 'string' || !Array.isArray(text) ? [text as InfoHintParagraph] : text;
  return { title: content.title, paragraphs, bullets: content.bullets ?? [] };
}

/** The same text flat, for screen readers (the button's description). */
export function infoHintText(content: InfoHintContent): string {
  const p = parts(content);
  return [p.title, ...p.paragraphs.map((x) => (typeof x === 'string' ? x : `${x.lead} ${x.text}`)), ...p.bullets].filter(Boolean).join(' ');
}

/**
 * A small «i» that explains the thing next to it. With a mouse it is a tooltip (hover or keyboard
 * focus; a click pins it); on a touch screen a tap opens it as a popover and a tap outside or
 * Escape closes it. The text is also the button's description, so a screen reader hears it on focus.
 */
export function InfoHint({ content, subject, label, position = 'top' }: InfoHintProps) {
  const ut = useUiText();
  const canHover = useMediaQuery('(hover: hover) and (pointer: fine)', false, { getInitialValueInEffect: false }) ?? false;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const dropdown = useRef<HTMLDivElement>(null);
  const descId = useId();
  const open = pinned || hovered || focused;

  const clearTimer = () => window.clearTimeout(timer.current);
  const close = () => {
    clearTimer();
    setPinned(false);
    setHovered(false);
    setFocused(false);
  };
  const hoverTo = (on: boolean) => {
    if (!canHover) return;
    clearTimer();
    timer.current = window.setTimeout(() => setHovered(on), on ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
  };
  useEffect(() => clearTimer, []);

  // Escape closes the hint first, not the dialog or drawer around it (Mantine's overlays skip a
  // keydown whose target carries data-mantine-stop-propagation)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const { title, paragraphs, bullets } = parts(content);
  const name = label ?? (subject ? ut('Explain: {subject}', { subject }) : ut('Explanation'));

  return (
    <Popover
      opened={open}
      onChange={(o) => {
        if (!o) close();
      }}
      position={position}
      offset={6}
      withArrow
      arrowSize={10}
      withinPortal
      withRoles={false}
      trapFocus={false}
      returnFocus={false}
      zIndex={360}
      middlewares={{ flip: true, shift: { padding: 12 } }}
      transitionProps={{ transition: 'fade', duration: 120 }}
    >
      <Popover.Target>
        <button
          type="button"
          className={s.trigger}
          aria-label={name}
          aria-describedby={descId}
          aria-expanded={open}
          data-open={open ? '' : undefined}
          data-mantine-stop-propagation={open ? 'true' : undefined}
          onClick={() => {
            if (pinned) close();
            else setPinned(true);
          }}
          onMouseEnter={() => hoverTo(true)}
          onMouseLeave={() => hoverTo(false)}
          onFocus={(e) => {
            // a mouse click focuses too; only keyboard focus opens the tooltip by itself
            if (e.currentTarget.matches(':focus-visible')) setFocused(true);
          }}
          onBlur={(e: FocusEvent<HTMLButtonElement>) => {
            setFocused(false);
            // a touch user may tap into the text to read it; outside taps close it there
            if (canHover && !dropdown.current?.contains(e.relatedTarget as Node | null)) setPinned(false);
          }}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'Escape' && open) {
              e.stopPropagation();
              close();
            }
          }}
        >
          <Icon name="info" size={16} />
          <span id={descId} hidden>
            {infoHintText(content)}
          </span>
        </button>
      </Popover.Target>
      <Popover.Dropdown
        ref={dropdown}
        className={s.dropdown}
        tabIndex={-1}
        aria-hidden
        data-mantine-stop-propagation="true"
        onMouseEnter={() => hoverTo(true)}
        onMouseLeave={() => hoverTo(false)}
      >
        {title ? <p className={s.title}>{title}</p> : null}
        {paragraphs.map((p, i) => (
          <p key={i} className={s.para}>
            {typeof p === 'string' ? (
              p
            ) : (
              <>
                <span className={s.lead}>{p.lead}</span> {p.text}
              </>
            )}
          </p>
        ))}
        {bullets.length ? (
          <ul className={s.list}>
            {bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        ) : null}
      </Popover.Dropdown>
    </Popover>
  );
}
