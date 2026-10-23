import { useState } from 'react';
import { Popover } from '@mantine/core';
import { Icon } from '../../basic/Icon';
import { useUiText } from '../../UiTextContext';
import { shownDecimals, withDecimals } from '../../basic/stepNumber';
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
  editor: {
    kind: 'number';
    min: number;
    max: number;
    step: number;
    unit?: string;
    /** How the popup stepper shows a value, when it is not a plain number with `unit` («68.0°F» for 20 °C). */
    format?: (value: number) => string;
  };
  value: number;
  onChange: (value: number) => void;
};
type RangePillProps = PillBase & { editor: { kind: 'time_range' }; value: { from: string; to: string }; onChange: (value: { from: string; to: string }) => void };

export type ValuePillProps = (PillBase & { editor?: undefined; value?: undefined; onChange?: undefined }) | SelectPillProps | NumberPillProps | RangePillProps;

// the editor kind sits one level down, which TypeScript does not narrow on by itself
const isSelect = (p: ValuePillProps): p is SelectPillProps => p.editor?.kind === 'select';
const isNumber = (p: ValuePillProps): p is NumberPillProps => p.editor?.kind === 'number';
const isRange = (p: ValuePillProps): p is RangePillProps => p.editor?.kind === 'time_range';

/** «3.5°», «66%», «90 min»: as many decimals as the step has, so 3.0 → 3.5 does not read «3 → 3.5». */
function numberText(value: number, step: number, unit?: string): string {
  const n = value.toFixed(shownDecimals(value, step)).replace(/^-/, '−');
  if (!unit) return n;
  return unit === '°' || unit === '%' ? `${n}${unit}` : `${n} ${unit}`;
}

/**
 * A setting's current value as a pill. With an editor it opens in place: a menu of options, a
 * stepper or a time range; changes apply immediately (the page autosaves).
 */
export function ValuePill(props: ValuePillProps) {
  const { ariaLabel } = props;
  // a number pill shows its value with the step's decimals, like the stepper it opens
  const text = isNumber(props) ? withDecimals(props.text, props.value, shownDecimals(props.value, props.editor.step)) : props.text;
  const name = ariaLabel ? `${ariaLabel}: ${text}` : undefined;
  if (isSelect(props)) return <SelectPill {...props} name={name} />;
  if (isNumber(props) || isRange(props)) return <EditorPill pill={props} text={text} name={name} />;
  return (
    <span className={s.valuePill} aria-label={name}>
      {text}
    </span>
  );
}

function EditorPill({ pill, text, name }: { pill: NumberPillProps | RangePillProps; text: string; name?: string }) {
  const ut = useUiText();
  const [open, setOpen] = useState(false);
  const { ariaLabel } = pill;
  return (
    // Escape closes the popup here, after a value being typed had its chance to cancel only the typing
    <Popover opened={open} onChange={setOpen} position="bottom-end" offset={6} withinPortal trapFocus returnFocus closeOnEscape={false} shadow="md">
      <Popover.Target>
        <button type="button" className={s.valuePill} aria-label={name} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {text}
          <Icon name="pencil" size={14} />
        </button>
      </Popover.Target>
      <Popover.Dropdown
        className={s.popover}
        aria-label={ariaLabel ?? text}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          setOpen(false);
        }}
      >
        {isNumber(pill) ? (
          <Stepper
            variant="square"
            value={pill.value}
            text={pill.editor.format ? pill.editor.format(pill.value) : numberText(pill.value, pill.editor.step, pill.editor.unit)}
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
