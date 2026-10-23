import type { ReactNode } from 'react';
import type { IconName, Tone } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Button } from '../../basic/Button';
import { Icon } from '../../basic/Icon';
import { IconButton } from '../../basic/IconButton';
import { InfoHint, type InfoHintContent } from '../../basic/InfoHint';
import { Link } from '../../shell/Link';
import { CodeBlock } from '../display/text';
import type { ChoiceValue } from '../inputs/choice';
import { RadioCardList, type RadioCardListProps } from '../inputs/radios';
import { Stepper, type StepperProps } from '../inputs/steppers';
import { TestButton, type TestButtonProps } from '../inputs/actions';
import type { KitAction } from '../internal/ActionButton';
import { toneVars } from '../internal/util';
import s from './rows.module.css';

/** «увімкнено» checkbox of a card; a locked one shows why. */
function EnableToggle({ checked, onToggle, locked }: { checked: boolean; onToggle: () => void; locked?: string }) {
  const ut = useUiText();
  return (
    <label className={s.enable} data-locked={locked ? '' : undefined} title={locked}>
      <input type="checkbox" checked={checked} disabled={Boolean(locked)} onChange={onToggle} />
      {locked ? <Icon name="lock" size={14} /> : null}
      {ut('enabled')}
    </label>
  );
}

function ToneChip({ tone, label, size }: { tone: Tone; label: string; size?: 'sm' }) {
  return (
    <span className={s.toneChip} style={toneVars(tone)} data-size={size}>
      {label}
    </span>
  );
}

/* ---------------- TriggerCard ---------------- */

export interface TriggerCardProps {
  icon: IconName;
  name: string;
  /** «стан сутності», «шаблон HA», «час». */
  kindLabel: string;
  /** Live state: «так · мережі немає», «ні · 4.2°». */
  live: { text: string; active: boolean; disabled: boolean; unavailable?: boolean };
  /** The definition in one or two lines (mono). */
  code: string;
  /** Who relies on it («ланцюжок опалення», «Передгрів електрикою»). */
  usages: string[];
  /** «використовують:». */
  usedByLabel: string;
  enabled: boolean;
  /** Built-in trigger: cannot be switched off (the reason). */
  locked?: string;
  onToggle: () => void;
  onEdit?: () => void;
}

/** A Home Assistant condition with its live state and its users. */
export function TriggerCard({ icon, name, kindLabel, live, code, usages, usedByLabel, enabled, locked, onToggle, onEdit }: TriggerCardProps) {
  const ut = useUiText();
  const liveState = live.disabled ? 'disabled' : live.unavailable ? 'unavailable' : live.active ? 'active' : 'idle';
  return (
    <div className={s.wellCard} data-bordered="" data-active={live.active && !live.disabled ? '' : undefined}>
      <div className={s.cardHead}>
        <span className={s.cardWho}>
          <span className={s.iconBox}>
            <Icon name={icon} size={18} />
          </span>
          <span>
            <span className={s.name}>{name}</span>
            <span className={s.muted}>{kindLabel}</span>
          </span>
        </span>
        <span className={s.cardRight}>
          <span className={s.live} data-state={liveState} role="status">
            {live.unavailable ? <Icon name="offline" size={14} /> : null}
            {live.text}
          </span>
          {onEdit ? <IconButton icon="pencil" label={ut('Edit «{name}»', { name })} size={36} variant="ghost" onClick={onEdit} /> : null}
        </span>
      </div>
      <CodeBlock code={code} wrap />
      <div className={s.cardFoot}>
        <span className={s.usages}>
          <span className={s.muted}>{usedByLabel}</span>
          {usages.map((u, i) => (
            <span key={`${u}-${i}`} className={s.softChip}>
              {u}
            </span>
          ))}
        </span>
        <EnableToggle checked={enabled} onToggle={onToggle} locked={locked} />
      </div>
    </div>
  );
}

/* ---------------- RuleCard ---------------- */

export interface RuleCardProps {
  /** «ПРИСУТНІСТЬ», «КАЛЕНДАР». */
  tag: string;
  title: string;
  text: string;
  enabled?: boolean;
  onToggle?: () => void;
}

/** A profile activation rule («Коли вмикається сам»). */
export function RuleCard({ tag, title, text, enabled, onToggle }: RuleCardProps) {
  return (
    <div className={s.ruleRow} data-off={enabled === false ? '' : undefined}>
      <span className={s.ruleTag}>{tag}</span>
      <span className={s.ruleText}>
        <span className={s.ruleTitle}>{title}</span>
        <span className={s.ruleSub}>{text}</span>
      </span>
      {onToggle && enabled != null ? <EnableToggle checked={enabled} onToggle={onToggle} /> : null}
    </div>
  );
}

/* ---------------- ActionRuleCard ---------------- */

export interface ActionRuleCardProps {
  /** Trigger name («Блекаут»). */
  when: string;
  /** «Економити». */
  action: string;
  /** What changes while active, one line each. */
  effects: string[];
  /** «Останній раз: учора 18:20–21:05». */
  last: string;
  enabled: boolean;
  /** The trigger is on right now. */
  active?: boolean;
  onToggle: () => void;
  onEdit?: () => void;
}

/** «коли «Блекаут» → Економити»: what a trigger changes while it is active. */
export function ActionRuleCard({ when, action, effects, last, enabled, active, onToggle, onEdit }: ActionRuleCardProps) {
  const ut = useUiText();
  return (
    <div className={s.wellCard} data-off={enabled ? undefined : ''} data-active={active && enabled ? '' : undefined}>
      <div className={s.whenLine}>
        <span className={s.whenPill}>{ut('when «{name}»', { name: when })}</span>
        <span className={s.whenArrow}>
          <Icon name="arrowRight" size={16} />
        </span>
        <span className={s.whenAction}>{action}</span>
        {active && enabled ? <ToneChip tone="event" label={ut('active now')} size="sm" /> : null}
        <span className={s.whenEnd}>
          {onEdit ? <IconButton icon="pencil" label={ut('Edit «{name}»', { name: action })} size={36} variant="ghost" onClick={onEdit} /> : null}
          <EnableToggle checked={enabled} onToggle={onToggle} />
        </span>
      </div>
      {effects.length ? (
        <ul className={s.effects}>
          {effects.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
      <span className={s.muted}>{last}</span>
    </div>
  );
}

/* ---------------- CircuitCard ---------------- */

/** A room on a circuit: how it takes part, what it does now and, on a zoned loop, its zone valves. */
export interface CircuitRoom {
  key: string;
  name: string;
  /** The room's page. */
  to?: string;
  /** How it takes part («розумні головки · 2», «звичайні радіатори»). */
  meta: string;
  /** What it does now («просить тепла»). */
  state?: { tone: Tone; label: string };
  /** Its zone valves or floor thermostats; `note` says how the loop uses them («відкривається з джерелом»). */
  zones?: { key: string; name: string; entityId: string; onRemove?: () => void }[];
  zoneNote?: string;
  /** «+ Клапан зони»: offered on a zoned loop. */
  onAddZone?: () => void;
  /** Takes the room off the circuit. */
  onRemove?: () => void;
}

export interface CircuitCardProps<T extends ChoiceValue> {
  name: string;
  icon?: IconName;
  /** The pump entities; empty: the loop has no pump of its own. */
  pumpEntity: string;
  /** «2 насоси · по черзі». */
  extra?: string;
  /** Pump state («працює», «вибіг до 14:20»). */
  chip: { tone: Tone; label: string };
  /** How the loop runs; each option says in a sentence what happens. */
  mode: Omit<RadioCardListProps<T>, 'compact' | 'surface'> & { label: string; hint?: InfoHintContent };
  /** Run-on after the pump's reason falls (always drawn as the compact row). Absent: no pump to run on. */
  runOn?: Omit<StepperProps, 'variant'> & { variant?: StepperProps['variant'] };
  /** Feeds and capabilities («від ТН і котла», «охолодження 18°»); a tone tints what a feed means. */
  chips: { label: string; tone?: Tone }[];
  /** What keeps the loop from working as set up («контур ніщо не живить»). */
  warning?: string;
  note?: string;
  /** What the pump entity is and when it is switched, behind an «i» after it. */
  pumpHint?: InfoHintContent;
  /** The member rooms; `add` puts another room on the loop. */
  rooms: { label: string; hint?: InfoHintContent; items: CircuitRoom[]; empty: string; add?: { label: string; onClick: () => void } };
  /** Buttons under the card («Об’єднати з…», «Налаштування й насоси»). */
  actions?: KitAction[];
}

function CircuitRoomRow({ room }: { room: CircuitRoom }) {
  const ut = useUiText();
  const zones = room.zones ?? [];
  return (
    <li className={s.circuitRoom}>
      <span className={s.circuitRoomHead}>
        <span className={s.circuitRoomText}>
          {room.to ? (
            <Link to={room.to} variant="plain">
              <span className={s.circuitRoomName}>{room.name}</span>
            </Link>
          ) : (
            <span className={s.circuitRoomName}>{room.name}</span>
          )}
          <span className={s.muted}>{room.meta}</span>
        </span>
        {room.state ? <ToneChip tone={room.state.tone} label={room.state.label} size="sm" /> : null}
        {room.onRemove ? (
          <IconButton icon="close" label={ut('Take «{room}» off the circuit', { room: room.name })} size={36} variant="ghost" onClick={room.onRemove} />
        ) : null}
      </span>
      {zones.length || room.onAddZone ? (
        <span className={s.circuitZones}>
          {zones.map((z) => (
            <span key={z.key} className={s.circuitZone}>
              <Icon name="floor" size={14} />
              <span className={s.circuitZoneText}>
                <span>{z.name}</span>
                <span className={s.mono}>{z.entityId}</span>
              </span>
              {z.onRemove ? <IconButton icon="close" label={ut('Remove «{name}»', { name: z.name })} size={36} variant="ghost" onClick={z.onRemove} /> : null}
            </span>
          ))}
          {room.zoneNote ? <span className={s.muted}>{room.zoneNote}</span> : null}
          {room.onAddZone ? (
            <span>
              <Button variant="ghost" size="sm" icon="plus" onClick={room.onAddZone} ariaLabel={ut('Add a zone valve to «{room}»', { room: room.name })}>
                {ut('Zone valve')}
              </Button>
            </span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** A house heating circuit: what feeds it, how it runs, its pump and run-on, the rooms on it. */
export function CircuitCard<T extends ChoiceValue>({ name, icon, pumpEntity, extra, chip, mode, runOn, chips, warning, note, pumpHint, rooms, actions }: CircuitCardProps<T>) {
  const ut = useUiText();
  const { label: modeLabel, hint: modeHint, ...modeList } = mode;
  return (
    <div className={s.wellCard}>
      <div className={s.cardHead}>
        <span className={s.cardWho}>
          {icon ? (
            <span className={s.iconBox}>
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <span>
            <span className={s.circuitTitle}>{name}</span>
            <span className={s.muted}>
              {pumpEntity ? (
                <>
                  {ut('pump')} <span className={s.circuitPump}>{pumpEntity}</span>
                </>
              ) : (
                ut('no pump of its own')
              )}
              {extra ? ` · ${extra}` : ''}
              {pumpHint ? (
                <>
                  {' '}
                  <InfoHint content={pumpHint} subject={ut('pump')} />
                </>
              ) : null}
            </span>
          </span>
        </span>
        <ToneChip tone={chip.tone} label={chip.label} />
      </div>
      {chips.length ? (
        <div className={s.chipRow}>
          {chips.map((c, i) => (
            <span key={`${c.label}-${i}`} className={s.softChip} style={c.tone ? toneVars(c.tone, 'chip') : undefined}>
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      {warning ? (
        <span className={s.circuitWarning} role="note">
          <Icon name="alert" size={16} />
          {warning}
        </span>
      ) : null}
      <div className={s.circuitBlock}>
        <span className={s.circuitBlockLabel}>
          {modeLabel}
          {modeHint ? (
            <>
              {' '}
              <InfoHint content={modeHint} subject={modeLabel} />
            </>
          ) : null}
        </span>
        <RadioCardList {...modeList} surface="well" />
      </div>
      {runOn ? <Stepper {...runOn} variant="compact" /> : null}
      <div className={s.circuitBlock}>
        <span className={s.circuitBlockHead}>
          <span className={s.circuitBlockLabel}>
            {rooms.label}
            {rooms.hint ? (
              <>
                {' '}
                <InfoHint content={rooms.hint} subject={rooms.label} />
              </>
            ) : null}
          </span>
          {rooms.add ? (
            <Button variant="ghost" size="sm" icon="plus" onClick={rooms.add.onClick}>
              {rooms.add.label}
            </Button>
          ) : null}
        </span>
        {rooms.items.length ? (
          <ul className={s.circuitRooms} aria-label={rooms.label}>
            {rooms.items.map((r) => (
              <CircuitRoomRow key={r.key} room={r} />
            ))}
          </ul>
        ) : (
          <span className={s.muted}>{rooms.empty}</span>
        )}
      </div>
      {note ? <span className={s.muted}>{note}</span> : null}
      {actions?.length ? (
        <div className={s.circuitActions}>
          {actions.map((a, i) => (
            <Button key={`${a.label}-${i}`} variant={a.variant ?? 'ghost'} size="sm" icon={a.icon} onClick={a.onClick} to={a.to} disabled={a.disabled} loading={a.loading}>
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- ChannelCard ---------------- */

export interface ChannelCardProps {
  icon: IconName;
  title: string;
  sub: string;
  status: { tone: Tone; label: string };
  children?: ReactNode;
  test?: TestButtonProps;
}

/** A notification channel: status, its settings (children) and a test button. */
export function ChannelCard({ icon, title, sub, status, children, test }: ChannelCardProps) {
  return (
    <div className={s.channel}>
      <div className={s.channelHead}>
        <span className={s.channelIcon}>
          <Icon name={icon} size={18} />
        </span>
        <span className={s.channelText}>
          <span className={s.name}>{title}</span>
          <span className={s.muted}>{sub}</span>
        </span>
        <ToneChip tone={status.tone} label={status.label} size="sm" />
      </div>
      {children}
      {test ? (
        <span className={s.channelTest}>
          <TestButton {...test} />
        </span>
      ) : null}
    </div>
  );
}
