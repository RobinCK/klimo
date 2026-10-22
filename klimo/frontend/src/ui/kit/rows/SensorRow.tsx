import { useId, type CSSProperties } from 'react';
import type { Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { IconButton } from '../../basic/IconButton';
import s from './rows.module.css';

export interface SensorRowProps {
  /** The «в розрахунку» checkbox; without `onToggle` the row has none (the sensor always counts when it can). */
  included?: boolean;
  onToggle?: (included: boolean) => void;
  name: string;
  entityId?: string;
  /** «вага 0.5» (weighted average only). */
  weightText?: string;
  /** «19.7°». */
  valueText: string;
  /** Not counted right now (outlier, offline, unchecked): the value is struck through. */
  excluded: boolean;
  /** «SNZB-02D · на зв’язку 4 хв тому». */
  meta: string;
  /** «+1.1° від інших — тимчасово не рахую». */
  note?: string;
  noteTone?: Tone;
  /** Opens the sensor's settings (name, weight). */
  onEdit?: () => void;
  /** Takes the sensor out of the list. */
  onRemove?: () => void;
}

/** One temperature sensor (of a room, or outdoors): whether it counts, its value and its health. */
export function SensorRow({ included = true, onToggle, name, entityId, weightText, valueText, excluded, meta, note, noteTone, onEdit, onRemove }: SensorRowProps) {
  const ut = useUiText();
  const id = useId();
  const label = (
    <>
      <span className={s.name}>{name}</span>
      {entityId ? <span className={s.mono}>{entityId}</span> : null}
    </>
  );
  return (
    <div className={s.sensor} data-plain={onToggle ? undefined : ''}>
      <div className={s.sensorMain}>
        {onToggle ? (
          <>
            <input
              id={id}
              type="checkbox"
              checked={included}
              aria-describedby={`${id}-meta`}
              onChange={(e) => onToggle(e.currentTarget.checked)}
            />
            <label htmlFor={id} className={s.sensorLabel}>
              {label}
            </label>
          </>
        ) : (
          <span className={s.sensorLabel}>{label}</span>
        )}
        {weightText ? <span className={s.weight}>{weightText}</span> : null}
        <span className={s.sensorValue} data-excluded={excluded || !included ? '' : undefined}>
          {valueText}
        </span>
        {onEdit ? <IconButton icon="pencil" label={ut('Edit sensor «{name}»', { name })} size={36} variant="ghost" onClick={onEdit} /> : null}
        {onRemove ? <IconButton icon="close" label={ut('Remove sensor «{name}»', { name })} size={36} variant="ghost" onClick={onRemove} /> : null}
      </div>
      <div id={`${id}-meta`} className={s.sensorMeta}>
        <span>{meta}</span>
        {note ? (
          <span className={s.note} style={noteTone ? ({ '--note-color': toneVar(noteTone, 'fg') } as CSSProperties) : undefined}>
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}
