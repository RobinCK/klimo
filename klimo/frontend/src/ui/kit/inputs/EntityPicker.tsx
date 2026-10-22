import { useEffect, useRef, useState } from 'react';
import { Combobox, useCombobox } from '@mantine/core';
import type { HaEntityDto } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { IconButton } from '../../basic/IconButton';
import { cx } from '../internal/util';
import s from './fields.module.css';

// typing pauses this long before the search runs (the HA registry search is server-side)
const DEBOUNCE_MS = 200;

type Search = (q: string) => Promise<HaEntityDto[]>;

/** Debounced search with stale-response protection; runs while `active`. */
export function useEntityResults(search: Search, query: string, active: boolean) {
  const [results, setResults] = useState<HaEntityDto[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    if (!active) return undefined;
    const my = ++seq.current;
    setState('loading');
    const t = window.setTimeout(() => {
      searchRef
        .current(query.trim())
        .then((list) => {
          if (my !== seq.current) return;
          setResults(list);
          setState('idle');
        })
        .catch(() => {
          if (my !== seq.current) return;
          setResults([]);
          setState('error');
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, active]);

  return { results, state };
}

function EntityOption({ e, checked }: { e: HaEntityDto; checked: boolean }) {
  const ut = useUiText();
  const meta = [e.areaName, e.deviceName && e.deviceName !== e.name ? e.deviceName : null, e.usedBy.length ? ut('used by {what}', { what: e.usedBy.map((u) => u.label).join(', ') }) : null]
    .filter(Boolean)
    .join(' · ');
  const stateText = !e.available ? ut('unavailable') : e.state == null ? '' : e.unit ? `${e.state} ${e.unit}` : e.state;
  return (
    <Combobox.Option value={e.entityId} className={s.option} active={checked}>
      <span className={s.optionText}>
        <span className={s.optionName}>{e.name}</span>
        <span className={s.optionId}>{e.entityId}</span>
        {meta ? <span className={s.optionMeta}>{meta}</span> : null}
      </span>
      {stateText ? (
        <span className={s.optionState} data-unavailable={!e.available ? '' : undefined}>
          {stateText}
        </span>
      ) : null}
    </Combobox.Option>
  );
}

interface SearchBoxProps {
  search: Search;
  placeholder: string;
  /** Text shown while the field is not being edited (the picked id). */
  display: string;
  selected: Set<string>;
  onPick: (e: HaEntityDto) => void;
  /** Keep the dropdown open after a pick (multi-select). */
  stayOpen?: boolean;
  clear?: { label: string; onClear: () => void };
  ariaLabel?: string;
  autoFocus?: boolean;
}

function SearchBox({ search, placeholder, display, selected, onPick, stayOpen, clear, ariaLabel, autoFocus }: SearchBoxProps) {
  const ut = useUiText();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setEditing(false);
      setQuery('');
    },
    onDropdownOpen: () => setEditing(true),
  });
  const { results, state } = useEntityResults(search, query, combobox.dropdownOpened);

  // keep the first match highlighted so Enter picks it
  useEffect(() => {
    if (combobox.dropdownOpened && results.length) combobox.selectFirstOption();
    // the store object is recreated on every render; only these two matter
  }, [results, combobox.dropdownOpened]);

  return (
    <Combobox
      store={combobox}
      withinPortal
      position="bottom-start"
      offset={6}
      zIndex={350}
      onOptionSubmit={(id) => {
        const e = results.find((r) => r.entityId === id);
        if (e) onPick(e);
        if (stayOpen) {
          setQuery('');
        } else {
          combobox.closeDropdown();
        }
      }}
    >
      <Combobox.DropdownTarget>
        <span className={s.picker}>
          <span className={s.pickerIcon}>
            <Icon name="search" size={16} />
          </span>
          <Combobox.EventsTarget>
            <input
              className={cx(s.input, s.pickerInput)}
              data-mono={!editing && display ? '' : undefined}
              data-clearable={clear ? '' : undefined}
              data-autofocus={autoFocus ? '' : undefined}
              type="text"
              role="combobox"
              aria-label={ariaLabel ?? placeholder}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              // while searching, the bound id stays visible as the hint
              placeholder={editing && display ? display : placeholder}
              value={editing ? query : display}
              onFocus={() => combobox.openDropdown()}
              onClick={() => combobox.openDropdown()}
              onBlur={() => combobox.closeDropdown()}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                combobox.openDropdown();
                combobox.updateSelectedOptionIndex();
              }}
            />
          </Combobox.EventsTarget>
          {clear && display && !editing ? (
            <span className={s.pickerClear}>
              <IconButton icon="close" label={clear.label} size={40} variant="ghost" onClick={clear.onClear} />
            </span>
          ) : null}
        </span>
      </Combobox.DropdownTarget>
      <Combobox.Dropdown className={s.dropdown}>
        <Combobox.Options>
          {results.map((e) => (
            <EntityOption key={e.entityId} e={e} checked={selected.has(e.entityId)} />
          ))}
          {!results.length ? (
            <Combobox.Empty className={s.empty}>
              {state === 'loading' ? ut('Searching…') : state === 'error' ? ut('Search failed — try again') : ut('Nothing found')}
            </Combobox.Empty>
          ) : null}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}

/* ---------------- EntityPicker ---------------- */

export interface EntityPickerProps {
  /** Picked entity id, null when nothing is bound. */
  value: string | null;
  onChange: (id: string | null, entity?: HaEntityDto) => void;
  /** Role-aware search provided by the page (`useEntitySearch`). */
  search: (q: string) => Promise<HaEntityDto[]>;
  placeholder: string;
  clearable?: boolean;
  /** Known details of the bound entity, shown under the field. */
  entity?: HaEntityDto | null;
  ariaLabel?: string;
  autoFocus?: boolean;
}

/** Searchable Home Assistant entity choice: name, id, area, live state and who already uses it. */
export function EntityPicker({ value, onChange, search, placeholder, clearable, entity, ariaLabel, autoFocus }: EntityPickerProps) {
  const ut = useUiText();
  const [picked, setPicked] = useState<HaEntityDto | null>(null);
  const known = entity ?? (picked && picked.entityId === value ? picked : null);
  return (
    <div className={s.field}>
      <SearchBox
        search={search}
        placeholder={placeholder}
        display={value ?? ''}
        selected={new Set(value ? [value] : [])}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        onPick={(e) => {
          setPicked(e);
          onChange(e.entityId, e);
        }}
        clear={clearable ? { label: ut('Clear'), onClear: () => onChange(null) } : undefined}
      />
      {known ? (
        <span className={s.help}>
          {[known.name, known.areaName, !known.available ? ut('unavailable') : known.state != null ? `${known.state}${known.unit ? ` ${known.unit}` : ''}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------- EntityMultiPicker ---------------- */

export interface EntityMultiPickerProps {
  value: string[];
  onChange: (ids: string[], picked?: HaEntityDto) => void;
  search: (q: string) => Promise<HaEntityDto[]>;
  placeholder: string;
  ariaLabel?: string;
}

/** Several entities: removable chips plus a search that adds (a pick of a chosen one removes it). */
export function EntityMultiPicker({ value, onChange, search, placeholder, ariaLabel }: EntityMultiPickerProps) {
  const ut = useUiText();
  const selected = new Set(value);
  return (
    <div className={s.field}>
      {value.length ? (
        <div className={s.chips} role="list" aria-label={ariaLabel ?? placeholder}>
          {value.map((id) => (
            <span key={id} className={s.entityChip} role="listitem">
              <span title={id}>{id}</span>
              <button
                type="button"
                className={s.chipRemove}
                aria-label={ut('Remove {id}', { id })}
                onClick={() => onChange(value.filter((v) => v !== id))}
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <SearchBox
        search={search}
        placeholder={placeholder}
        display=""
        selected={selected}
        stayOpen
        ariaLabel={ariaLabel}
        onPick={(e) => onChange(selected.has(e.entityId) ? value.filter((v) => v !== e.entityId) : [...value, e.entityId], e)}
      />
    </div>
  );
}
