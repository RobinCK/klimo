import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { HaEntityDto } from '@api/model';
import type { IconName } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { IconButton } from '../../basic/IconButton';
import { VisuallyHidden } from '../../basic/VisuallyHidden';
import { cx } from '../internal/util';
import { useEntityResults, usedByText } from './EntityPicker';
import f from './fields.module.css';
import s from './finder.module.css';

export interface EntityFinderChoice {
  value: string;
  label: string;
  icon?: IconName;
}

export interface EntityFinderProps {
  /** Role-aware search provided by the page (`useEntitySearch`). */
  search: (q: string) => Promise<HaEntityDto[]>;
  /**
   * What a result can be added as. One choice: a click or Enter adds it. Several (likeliest first):
   * each is its own option, so the user says which instead of the search guessing.
   */
  choices: (e: HaEntityDto) => EntityFinderChoice[];
  onPick: (e: HaEntityDto, choice: string) => void;
  placeholder: string;
  ariaLabel?: string;
  /** The value on the right of a result; its state by default. */
  valueText?: (e: HaEntityDto) => string | null;
  /** A quiet note on a result («already added», «in Bedroom — will be moved»). */
  note?: (e: HaEntityDto) => string | null;
  /** Why a result cannot be added (it stays in the list, dimmed, with the reason). */
  blocked?: (e: HaEntityDto) => string | null;
  autoFocus?: boolean;
  /** Shown under the field while the list is closed. */
  help?: string;
}

interface Option {
  e: HaEntityDto;
  c: EntityFinderChoice;
}

const keep = (ev: MouseEvent) => ev.preventDefault();

/**
 * Search that adds: type a name or an entity id, the results open in place under the field (no
 * floating layer to lose on a phone) with what each one is, and a click or Enter adds it. Arrow keys
 * walk through every choice of every result; Escape closes the list, a second Escape clears the text.
 */
export function EntityFinder({ search, choices, onPick, placeholder, ariaLabel, valueText, note, blocked, autoFocus, help }: EntityFinderProps) {
  const ut = useUiText();
  const id = useId();
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-o${i}`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [said, setSaid] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { results, state } = useEntityResults(search, query, open);

  const rows = results
    .map((e) => {
      const why = blocked?.(e) ?? null;
      return { e, why, cs: why ? [] : choices(e) };
    })
    .filter((r) => r.cs.length > 0 || r.why);
  const options: Option[] = rows.flatMap((r) => r.cs.map((c) => ({ e: r.e, c })));
  const index = new Map(options.map((o, i) => [`${o.e.entityId}|${o.c.value}`, i]));

  useEffect(() => setActive(0), [results]);
  useEffect(() => {
    if (open) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
    // optId is derived from the stable id
  }, [active, open]);

  const pick = (o: Option) => {
    onPick(o.e, o.c.value);
    setSaid(ut('Added: {name} — {what}', { name: o.e.name, what: o.c.label }));
    setQuery('');
    setOpen(false);
    input.current?.focus();
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (ev.key === 'Enter') {
      const o = open ? options[active] : undefined;
      if (o) {
        ev.preventDefault();
        pick(o);
      }
    } else if (ev.key === 'Escape' && (open || query)) {
      // the list or the text goes first; the dialog around it closes on the next Escape
      ev.preventDefault();
      ev.stopPropagation();
      if (open) setOpen(false);
      else setQuery('');
    }
  };

  const onBlur = (ev: FocusEvent) => {
    if (!box.current?.contains(ev.relatedTarget as Node | null)) setOpen(false);
  };

  const stateText = (e: HaEntityDto) => {
    const v = valueText?.(e);
    if (v != null) return v;
    if (!e.available) return ut('unavailable');
    return e.state == null ? '' : e.unit ? `${e.state} ${e.unit}` : e.state;
  };

  const option = (o: Option, single: boolean, children: ReactNode) => {
    const i = index.get(`${o.e.entityId}|${o.c.value}`) ?? 0;
    return (
      <div
        key={`${o.e.entityId}|${o.c.value}`}
        id={optId(i)}
        role="option"
        aria-selected={i === active}
        aria-label={single ? undefined : `${o.e.name} — ${o.c.label}`}
        className={single ? s.row : s.choice}
        data-active={i === active ? '' : undefined}
        onMouseDown={keep}
        onMouseMove={() => i !== active && setActive(i)}
        onClick={() => pick(o)}
      >
        {children}
      </div>
    );
  };

  const text = (e: HaEntityDto, why?: string | null) => {
    const meta = [e.areaName, e.deviceName && e.deviceName !== e.name ? e.deviceName : null, usedByText(e, ut)].filter(Boolean).join(' · ');
    const extra = why ?? note?.(e);
    return (
      <span className={s.text}>
        <span className={s.name}>{e.name}</span>
        <span className={s.id}>{e.entityId}</span>
        {meta ? <span className={s.meta}>{meta}</span> : null}
        {extra ? <span className={s.note}>{extra}</span> : null}
      </span>
    );
  };

  const value = (e: HaEntityDto) => {
    const v = stateText(e);
    return v ? (
      <span className={s.value} data-unavailable={!e.available ? '' : undefined}>
        {v}
      </span>
    ) : null;
  };

  return (
    <div className={s.finder} ref={box} onBlur={onBlur}>
      <span className={f.picker}>
        <span className={f.pickerIcon}>
          <Icon name="search" size={18} />
        </span>
        <input
          ref={input}
          className={cx(f.input, f.pickerInput, s.input)}
          data-clearable={query ? '' : undefined}
          data-autofocus={autoFocus ? '' : undefined}
          autoFocus={autoFocus}
          type="text"
          role="combobox"
          aria-label={ariaLabel ?? placeholder}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? optId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={placeholder}
          value={query}
          onChange={(ev) => {
            setQuery(ev.currentTarget.value);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <span className={f.pickerClear}>
            <IconButton
              icon="close"
              label={ut('Clear')}
              size={40}
              variant="ghost"
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
            />
          </span>
        ) : null}
      </span>
      {open ? (
        <div id={listId} role="listbox" aria-label={ariaLabel ?? placeholder} className={s.list}>
          {rows.map(({ e, cs, why }) =>
            why ? (
              <div key={e.entityId} role="option" aria-selected={false} aria-disabled="true" className={s.row} data-blocked="">
                {text(e, why)}
                <span className={s.side}>{value(e)}</span>
              </div>
            ) : cs.length === 1 ? (
              option({ e, c: cs[0] }, true, (
                <>
                  {text(e)}
                  <span className={s.side}>
                    {value(e)}
                    <span className={s.tag}>
                      {cs[0].icon ? <Icon name={cs[0].icon} size={14} /> : null}
                      {cs[0].label}
                    </span>
                  </span>
                </>
              ))
            ) : (
              <div key={e.entityId} role="group" aria-label={e.name} className={s.multi}>
                <span className={s.multiHead}>
                  {text(e)}
                  <span className={s.side}>{value(e)}</span>
                </span>
                <span className={s.choices}>
                  <span className={s.choicesLabel} aria-hidden="true">
                    {ut('Add as')}
                  </span>
                  {cs.map((c) =>
                    option({ e, c }, false, (
                      <>
                        {c.icon ? <Icon name={c.icon} size={14} /> : null}
                        {c.label}
                      </>
                    )),
                  )}
                </span>
              </div>
            ),
          )}
          {!rows.length ? (
            <div className={s.empty}>{state === 'loading' ? ut('Searching…') : state === 'error' ? ut('Search failed — try again') : ut('Nothing found')}</div>
          ) : null}
        </div>
      ) : help ? (
        <span className={f.help}>{help}</span>
      ) : null}
      <VisuallyHidden live="polite">{said}</VisuallyHidden>
    </div>
  );
}
