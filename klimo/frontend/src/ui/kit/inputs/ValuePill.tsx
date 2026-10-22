import { useState } from 'react';
import { Popover } from '@mantine/core';
import { Icon } from '../../basic/Icon';
import { useUiText } from '../../UiTextContext';
import { Stepper } from './steppers';
import { TimeRangeInput } from './fields';
import { useRoving } from '../internal/useRoving';
import s from './fields.module.css';

interface PillBase {
  /** What the pill shows («90 хв», «до кінця слоту»). */
  text: string;
  /** What the value is, for screen readers («Недоступний без оновлень»). */
  ariaLabel?: string;
}

type SelectPillProps = PillBase & { editor: { kind: 'select'; options: { value: string; label: string }[] }; value: string; onChange: (value: string) => void };
type NumberPillProps = PillBase & {
  editor: { kind: 'number'; min: number; max: number; step: number; unit?: string };
  value: number;
  onChange: (value: number) => void;
};
type RangePillProps = PillBase & { editor: { kind: 'time_range' }; value: { from: string; to: string }; onChange: (value: { from: string; to: string }) => void };

export type ValuePillProps = (PillBase & { editor?: undefined; value?: undefined; onChange?: undefined }) | SelectPillProps | NumberPillProps | RangePillProps;

// the editor kind sits one level down, which TypeScript does not narrow on by itself
const isSelect = (p: ValuePillProps): p is SelectPillProps => p.editor?.kind === 'select';
const isNumber = (p: ValuePillProps): p is NumberPillProps => p.editor?.kind === 'number';
const isRange = (p: ValuePillProps): p is RangePillProps => p.editor?.kind === 'time_range';

/**
 * A setting's current value as a pill. With an editor it opens in place: a menu of options, a
 * stepper or a time range; changes apply immediately (the page autosaves).
 */
export function ValuePill(props: ValuePillProps) {
  const { text, ariaLabel } = props;
  const name = ariaLabel ? `${ariaLabel}: ${text}` : undefined;
  if (isSelect(props)) return <SelectPill {...props} name={name} />;
  if (isNumber(props) || isRange(props)) return <EditorPill pill={props} name={name} />;
  return (
    <span className={s.valuePill} aria-label={name}>
      {text}
    </span>
  );
}

function EditorPill({ pill, name }: { pill: NumberPillProps | RangePillProps; name?: string }) {
  const ut = useUiText();
  const [open, setOpen] = useState(false);
  const { text, ariaLabel } = pill;
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-end" offset={6} withinPortal trapFocus returnFocus shadow="md">
      <Popover.Target>
        <button type="button" className={s.valuePill} aria-label={name} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {text}
          <Icon name="pencil" size={14} />
        </button>
      </Popover.Target>
      <Popover.Dropdown className={s.popover} aria-label={ariaLabel ?? text}>
        {isNumber(pill) ? (
          <Stepper
            variant="square"
            value={pill.value}
            text={pill.editor.unit ? `${pill.value} ${pill.editor.unit}` : String(pill.value)}
            min={pill.editor.min}
            max={pill.editor.max}
            step={pill.editor.step}
            onChange={pill.onChange}
            label={ariaLabel}
            ariaDec={ut('Less')}
            ariaInc={ut('More')}
          />
        ) : (
          <TimeRangeInput from={pill.value.from} to={pill.value.to} onChange={pill.onChange} ariaLabel={ariaLabel} />
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

function SelectPill({
  text,
  ariaLabel,
  name,
  editor,
  value,
  onChange,
}: SelectPillProps & { name?: string }) {
  const [open, setOpen] = useState(false);
  const { options } = editor;
  // arrows only move focus here; Enter or a click picks
  const { setRef, onKeyDown } = useRoving(options.length, { orientation: 'vertical', onMove: () => undefined });
  const selected = options.findIndex((o) => o.value === value);
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-end" offset={6} withinPortal trapFocus returnFocus shadow="md">
      <Popover.Target>
        <button type="button" className={s.valuePill} aria-label={name} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {text}
          <Icon name="chevronDown" size={14} />
        </button>
      </Popover.Target>
      <Popover.Dropdown className={s.popover}>
        <div role="menu" aria-label={ariaLabel ?? text} className={s.menuList}>
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={setRef(i)}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              tabIndex={i === (selected >= 0 ? selected : 0) ? 0 : -1}
              data-autofocus={i === (selected >= 0 ? selected : 0) ? '' : undefined}
              className={s.menuItem}
              onKeyDown={(e) => onKeyDown(e, i)}
              onClick={() => {
                if (o.value !== value) onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
              {o.value === value ? <Icon name="check" size={16} /> : null}
            </button>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
