import { useId, useState } from 'react';
import { Popover } from '@mantine/core';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { IconButton } from '../../basic/IconButton';
import { useRoving } from '../internal/useRoving';
import f from '../inputs/fields.module.css';
import s from './deviceRow.module.css';

export interface DeviceRowRole {
  value: string;
  /** What the device can be switched to; one option shows as a plain label. */
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

export interface DeviceRowProps {
  title: string;
  /** «SONOFF TRVZB · ext. sensor ✓ · LQI 115» or the entity id. */
  meta?: string;
  /** The live value on the right («19.4°», «closed»). */
  value?: string;
  /** Given for a device offered from the area: a checkbox decides whether it is taken. */
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  /** The checkbox cannot be ticked (a source already switches the device). */
  disabled?: boolean;
  /** «Use as…»: shown while the device is taken. */
  role?: DeviceRowRole;
  /** A device added by hand is removed instead of unticked. */
  onRemove?: () => void;
  /** What is wrong with it (a server check of this device). */
  error?: string;
}

/** One device of a list being assembled (the add-room wizard): what it is, its value, its role. */
export function DeviceRow({ title, meta, value, checked, onCheck, disabled, role, onRemove, error }: DeviceRowProps) {
  const ut = useUiText();
  const id = useId();
  const box = checked !== undefined;
  const taken = !box || checked;
  const actions = taken && (role || onRemove);
  return (
    <div className={s.row} data-check={box ? '' : undefined} data-disabled={disabled ? '' : undefined} data-error={error ? '' : undefined}>
      {box ? (
        <input
          id={id}
          type="checkbox"
          className={s.check}
          checked={checked}
          disabled={disabled}
          aria-describedby={[meta ? `${id}-meta` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onCheck?.(e.currentTarget.checked)}
        />
      ) : null}
      <label htmlFor={box ? id : undefined} className={s.text}>
        <span className={s.title}>{title}</span>
        {meta ? (
          <span id={`${id}-meta`} className={s.meta}>
            {meta}
          </span>
        ) : null}
      </label>
      {value ? <span className={s.value}>{value}</span> : null}
      {error ? (
        <span id={`${id}-err`} className={s.error} role="alert">
          <Icon name="alert" size={14} />
          {error}
        </span>
      ) : null}
      {actions ? (
        <span className={s.actions}>
          {role ? <RoleMenu role={role} device={title} /> : <span />}
          {onRemove ? <IconButton icon="close" label={ut('Remove «{name}»', { name: title })} size={36} variant="ghost" onClick={onRemove} /> : null}
        </span>
      ) : null}
    </div>
  );
}

function RoleMenu({ role, device }: { role: DeviceRowRole; device: string }) {
  const ut = useUiText();
  const [open, setOpen] = useState(false);
  const { options, value, onChange } = role;
  const current = options.find((o) => o.value === value) ?? options[0];
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  const { setRef, onKeyDown } = useRoving(options.length, { orientation: 'vertical', onMove: () => undefined });
  if (!current) return null;
  if (options.length < 2) return <span className={s.role}>{current.label}</span>;
  const menuLabel = ut('Use «{name}» as', { name: device });
  return (
    // above the wizard's modal, like the entity picker's list
    <Popover opened={open} onChange={setOpen} position="bottom-start" offset={6} withinPortal trapFocus returnFocus shadow="md" zIndex={350}>
      <Popover.Target>
        <button
          type="button"
          className={s.roleButton}
          aria-label={`${menuLabel}: ${current.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {current.label}
          <Icon name="chevronDown" size={14} />
        </button>
      </Popover.Target>
      <Popover.Dropdown className={f.popover}>
        <div role="menu" aria-label={menuLabel} className={f.menuList}>
          <span className={s.menuTitle} aria-hidden="true">
            {ut('Use as')}
          </span>
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={setRef(i)}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              tabIndex={i === selected ? 0 : -1}
              data-autofocus={i === selected ? '' : undefined}
              className={f.menuItem}
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
